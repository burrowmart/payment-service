/**
 * Outbox module integration tests for payment-service.
 *
 * Uses the saga participant charge handler as the event source.
 *
 * Prerequisites:
 *   docker compose -f ../platform-infra/docker-compose.yml up -d redis rabbitmq
 *
 * Mongo RS is started automatically by outbox-global-setup.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as amqplib from 'amqplib';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { createEnvelope, ROUTING_KEYS, EXCHANGES, QUEUES } from '@demo/contracts';
import type { ChargePayload } from '@demo/contracts';
import { AppModule } from '../src/app.module';
import { OutboxPublisherService } from '../src/common/outbox/outbox-publisher.service';
import { LeaderLockService } from '../src/common/outbox/leader-lock.service';
import { IdempotentConsumerService } from '../src/common/outbox/idempotent-consumer.service';
import { OutboxEntity, OutboxDocument } from '../src/common/outbox/schemas/outbox.schema';
import { OutboxStateEntity, OutboxStateDocument } from '../src/common/outbox/schemas/outbox-state.schema';
import { ProcessedMessageEntity, ProcessedMessageDocument } from '../src/common/outbox/schemas/processed-message.schema';
import { PaymentEntity, PaymentDocument } from '../src/payments/schemas/payment.schema';
import { SagaStepResultEntity, SagaStepResultDocument } from '../src/saga-participant/schemas/saga-step-result.schema';
import { PaymentSagaHandler } from '../src/saga-participant/payment-saga.handler';

const AMQP_URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';
const REPLY_QUEUE = QUEUES.PAYMENT_SUCCEEDED;

async function consumeOne(conn: amqplib.ChannelModel, queue: string, timeoutMs = 7_000): Promise<any> {
  const ch = await conn.createChannel();
  try {
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout on ${queue}`)), timeoutMs);
      void ch.consume(queue, (msg) => {
        if (\!msg) return;
        clearTimeout(timer);
        ch.ack(msg);
        resolve(JSON.parse(msg.content.toString()));
      }, { noAck: false });
    });
  } finally {
    await ch.close().catch(() => undefined);
  }
}

async function expectNoMessage(conn: amqplib.ChannelModel, queue: string, timeoutMs = 800): Promise<void> {
  const ch = await conn.createChannel();
  try {
    const got = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void ch.consume(queue, (msg) => {
        if (\!msg) return;
        clearTimeout(timer);
        ch.nack(msg, false, true);
        resolve(true);
      }, { noAck: false });
    });
    expect(got).toBe(false);
  } finally {
    await ch.close().catch(() => undefined);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Outbox module (payment-service e2e)', () => {
  let app: INestApplication;
  let publisher: OutboxPublisherService;
  let idempotentConsumer: IdempotentConsumerService;
  let outboxModel: Model<OutboxDocument>;
  let stateModel: Model<OutboxStateDocument>;
  let processedModel: Model<ProcessedMessageDocument>;
  let paymentModel: Model<PaymentDocument>;
  let stepResultModel: Model<SagaStepResultDocument>;
  let sagaHandler: PaymentSagaHandler;
  let amqpConn: amqplib.ChannelModel;
  let amqpCh: amqplib.Channel;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();

    publisher = module.get(OutboxPublisherService);
    idempotentConsumer = module.get(IdempotentConsumerService);
    sagaHandler = module.get(PaymentSagaHandler);
    outboxModel = module.get(getModelToken(OutboxEntity.name));
    stateModel = module.get(getModelToken(OutboxStateEntity.name));
    processedModel = module.get(getModelToken(ProcessedMessageEntity.name));
    paymentModel = module.get(getModelToken(PaymentEntity.name));
    stepResultModel = module.get(getModelToken(SagaStepResultEntity.name));

    amqpConn = await amqplib.connect(AMQP_URL);
    amqpCh = await amqpConn.createChannel();
    await amqpCh.assertExchange(EXCHANGES.SAGA_REPLIES, 'direct', { durable: true });
    await amqpCh.assertQueue(REPLY_QUEUE, { durable: true });
    await amqpCh.bindQueue(REPLY_QUEUE, EXCHANGES.SAGA_REPLIES, ROUTING_KEYS.PAYMENT_SUCCEEDED);
    await amqpCh.purgeQueue(REPLY_QUEUE).catch(() => undefined);
  });

  afterAll(async () => {
    await amqpCh?.close();
    await amqpConn?.close();
    await app.close();
  });

  afterEach(async () => {
    publisher.prePublishHook = undefined;
    await outboxModel.deleteMany({}).catch(() => undefined);
    await stateModel.deleteMany({}).catch(() => undefined);
    await processedModel.deleteMany({}).catch(() => undefined);
    await stepResultModel.deleteMany({}).catch(() => undefined);
    await paymentModel.deleteMany({}).catch(() => undefined);
    await amqpCh.purgeQueue(REPLY_QUEUE).catch(() => undefined);
  });

  it('(a) charge → payment-succeeded appears in RabbitMQ exactly once', async () => {
    const sagaId = randomUUID();
    const env = buildChargeEnvelope(sagaId, 100);

    await sagaHandler.handleCharge(env);

    const msg = await consumeOne(amqpConn, REPLY_QUEUE);
    expect(msg.type).toBe(ROUTING_KEYS.PAYMENT_SUCCEEDED);
    expect(msg.payload.sagaId).toBe(sagaId);

    await delay(200);
    const row = await outboxModel.findOne({ routingKey: ROUTING_KEYS.PAYMENT_SUCCEEDED }).lean();
    expect(row?.published).toBe(true);

    await expectNoMessage(amqpConn, REPLY_QUEUE);
  });

  it('(b) crash after Mongo commit → republishes on drainBacklog()', async () => {
    // Warmup to get a resumeToken saved
    const warmupSagaId = randomUUID();
    await sagaHandler.handleCharge(buildChargeEnvelope(warmupSagaId, 50));
    await consumeOne(amqpConn, REPLY_QUEUE, 7_000);
    await delay(500);

    const stateAfterWarmup = await stateModel.findById('default').lean();
    expect(stateAfterWarmup?.resumeToken).toBeDefined();

    await stepResultModel.deleteMany({});
    await processedModel.deleteMany({});
    await paymentModel.deleteMany({});

    let hookFired = false;
    publisher.prePublishHook = async () => {
      if (hookFired) return;
      hookFired = true;
      publisher.prePublishHook = undefined;
      throw new Error('simulated crash');
    };

    const sagaId = randomUUID();
    await sagaHandler.handleCharge(buildChargeEnvelope(sagaId, 200));
    await delay(300);
    expect(hookFired).toBe(true);

    const unpub = await outboxModel.findOne({ 'envelope.payload.sagaId': sagaId }).lean();
    expect(unpub?.published).toBe(false);

    await publisher.drainBacklog();
    const msg = await consumeOne(amqpConn, REPLY_QUEUE);
    expect(msg.payload.sagaId).toBe(sagaId);
    await expectNoMessage(amqpConn, REPLY_QUEUE);
  });

  it('(c) two instances → only leader publishes (Redis lock)', async () => {
    const redis2 = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const lock2 = new LeaderLockService(redis2);
    const acquired = await lock2.acquire();
    expect(acquired).toBe(false);
    await redis2.quit();

    const sagaId = randomUUID();
    await sagaHandler.handleCharge(buildChargeEnvelope(sagaId, 300));
    const msg = await consumeOne(amqpConn, REPLY_QUEUE);
    expect(msg.payload.sagaId).toBe(sagaId);
    await expectNoMessage(amqpConn, REPLY_QUEUE);
  });

  it('(d) duplicate messageId → handler invoked exactly once', async () => {
    const envelope = buildChargeEnvelope(randomUUID(), 150);

    let callCount = 0;
    const origHandle = idempotentConsumer.handle.bind(idempotentConsumer);
    jest.spyOn(idempotentConsumer, 'handle').mockImplementation(async (env, handler, opts) => {
      callCount++;
      return origHandle(env, handler, opts);
    });

    await sagaHandler.handleCharge(envelope);
    await sagaHandler.handleCharge(envelope);

    expect(callCount).toBe(2);
    const rows = await outboxModel.find({}).lean();
    expect(rows).toHaveLength(1);

    jest.restoreAllMocks();
  });
});

function buildChargeEnvelope(sagaId: string, amount: number) {
  return createEnvelope<ChargePayload>(
    ROUTING_KEYS.CHARGE,
    { sagaId, orderId: randomUUID(), userId: 'user@example.com', amount },
    { sagaId, step: ROUTING_KEYS.CHARGE, correlationId: randomUUID() },
  );
}
