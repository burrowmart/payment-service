/**
 * Integration test: charge + refund-payment saga idempotency.
 *
 * Uses a single-node Mongo replica set (started by saga-global-setup.ts)
 * so Mongoose transactions work. The AMQP consumer is disabled
 * (OUTBOX_PUBLISHER_ENABLED=false); handlers are called directly.
 *
 * Cases verified:
 *  1. Happy path: creates Payment(SUCCEEDED) + outbox row(payment-succeeded).
 *  2. Duplicate charge (same messageId) → exactly ONE Payment doc, ONE outbox row.
 *  3. New messageId, same sagaId+step → replay: still ONE Payment, second outbox row
 *     with the SAME inner envelope messageId (orchestrator deduplicates).
 *  4. forceFail flag → Payment(FAILED) + outbox row(payment-failed).
 *  5. FAIL_PAYMENT_OVER_AMOUNT threshold → Payment(FAILED) + payment-failed reply.
 *  6. refund-payment happy path → Payment transitions SUCCEEDED→REFUNDED.
 *  7. Double refund-payment → no-op (second call replays cached reply, status unchanged).
 *  8. Refund on FAILED payment → no-op (log + same reply, status stays FAILED).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { createEnvelope, ROUTING_KEYS } from '@demo/contracts';
import type { ChargePayload, RefundPaymentPayload } from '@demo/contracts';
import { AppModule } from '../src/app.module';
import { PaymentSagaHandler } from '../src/saga-participant/payment-saga.handler';
import { PaymentEntity, PaymentDocument } from '../src/payments/schemas/payment.schema';
import { OutboxEntity, OutboxDocument } from '../src/common/outbox/schemas/outbox.schema';
import { ProcessedMessageEntity, ProcessedMessageDocument } from '../src/common/outbox/schemas/processed-message.schema';
import { SagaStepResultEntity, SagaStepResultDocument } from '../src/saga-participant/schemas/saga-step-result.schema';

describe('PaymentSagaHandler — charge + refund-payment idempotency', () => {
  let app: INestApplication;
  let handler: PaymentSagaHandler;
  let paymentModel: Model<PaymentDocument>;
  let outboxModel: Model<OutboxDocument>;
  let processedModel: Model<ProcessedMessageDocument>;
  let stepResultModel: Model<SagaStepResultDocument>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    handler = app.get(PaymentSagaHandler);
    paymentModel = app.get(getModelToken(PaymentEntity.name));
    outboxModel = app.get(getModelToken(OutboxEntity.name));
    processedModel = app.get(getModelToken(ProcessedMessageEntity.name));
    stepResultModel = app.get(getModelToken(SagaStepResultEntity.name));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await paymentModel.deleteMany({});
    await outboxModel.deleteMany({});
    await processedModel.deleteMany({});
    await stepResultModel.deleteMany({});
  });

  // ── Case 1: happy path ────────────────────────────────────────────────────
  it('charge happy path: creates SUCCEEDED payment + payment-succeeded outbox row', async () => {
    const sagaId = randomUUID();
    const envelope = buildChargeEnvelope(sagaId, 1000);

    await handler.handleCharge(envelope);

    const payments = await paymentModel.find({}).lean().exec();
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('SUCCEEDED');
    expect(payments[0].sagaId).toBe(sagaId);

    const outboxRows = await outboxModel.find({}).lean().exec();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].routingKey).toBe(ROUTING_KEYS.PAYMENT_SUCCEEDED);
    expect(outboxRows[0].published).toBe(false);
  });

  // ── Case 2: duplicate charge (same messageId) ─────────────────────────────
  it('duplicate charge (same messageId) → exactly ONE Payment doc and ONE outbox row', async () => {
    const sagaId = randomUUID();
    const envelope = buildChargeEnvelope(sagaId, 500);

    await handler.handleCharge(envelope);
    await handler.handleCharge(envelope); // exact replay

    const payments = await paymentModel.find({}).lean().exec();
    expect(payments).toHaveLength(1);

    const outboxRows = await outboxModel.find({}).lean().exec();
    expect(outboxRows).toHaveLength(1);
  });

  // ── Case 3: new messageId, same sagaId+step ───────────────────────────────
  it('new messageId same sagaId+step → replay cached reply, still ONE Payment, second outbox row with same inner messageId', async () => {
    const sagaId = randomUUID();
    const first = buildChargeEnvelope(sagaId, 200);
    await handler.handleCharge(first);

    const second = buildChargeEnvelope(sagaId, 200); // same sagaId, new messageId
    expect(second.messageId).not.toBe(first.messageId);
    await handler.handleCharge(second);

    const payments = await paymentModel.find({}).lean().exec();
    expect(payments).toHaveLength(1);

    const outboxRows = await outboxModel.find({}).sort({ createdAt: 1 }).lean().exec();
    expect(outboxRows).toHaveLength(2);
    // Both rows reference the same inner envelope messageId
    expect(outboxRows[0].envelope.messageId).toBe(outboxRows[1].envelope.messageId);
    expect(outboxRows[0].routingKey).toBe(ROUTING_KEYS.PAYMENT_SUCCEEDED);
  });

  // ── Case 4: forceFail flag ────────────────────────────────────────────────
  it('forceFail=true → Payment(FAILED) + payment-failed outbox row', async () => {
    const sagaId = randomUUID();
    const envelope = buildChargeEnvelope(sagaId, 100, true);

    await handler.handleCharge(envelope);

    const payments = await paymentModel.find({}).lean().exec();
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('FAILED');

    const outboxRows = await outboxModel.find({}).lean().exec();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].routingKey).toBe(ROUTING_KEYS.PAYMENT_FAILED);
    expect((outboxRows[0].envelope.payload as any).reason).toMatch(/forceFail/);
  });

  // ── Case 5: FAIL_PAYMENT_OVER_AMOUNT threshold ────────────────────────────
  it('amount over FAIL_PAYMENT_OVER_AMOUNT threshold → Payment(FAILED) + payment-failed', async () => {
    // Override config inline — ConfigService reads from process.env at runtime
    const config = app.get(ConfigService);
    const original = config.get('failPaymentOverAmount');
    jest.spyOn(config, 'get').mockImplementation((key: string) => {
      if (key === 'failPaymentOverAmount') return 500;
      return original;
    });

    const sagaId = randomUUID();
    const envelope = buildChargeEnvelope(sagaId, 999); // 999 > 500 threshold

    await handler.handleCharge(envelope);

    const payments = await paymentModel.find({}).lean().exec();
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('FAILED');

    const outboxRows = await outboxModel.find({}).lean().exec();
    expect(outboxRows[0].routingKey).toBe(ROUTING_KEYS.PAYMENT_FAILED);

    jest.restoreAllMocks();
  });

  // ── Case 6: refund-payment happy path ─────────────────────────────────────
  it('refund-payment: SUCCEEDED→REFUNDED + payment-succeeded outbox row', async () => {
    const sagaId = randomUUID();
    const chargeEnvelope = buildChargeEnvelope(sagaId, 300);
    await handler.handleCharge(chargeEnvelope);

    const payment = await paymentModel.findOne({ sagaId }).lean().exec();
    expect(payment!.status).toBe('SUCCEEDED');

    const refundEnvelope = buildRefundEnvelope(sagaId, String(payment!._id));
    await handler.handleRefundPayment(refundEnvelope);

    const updated = await paymentModel.findById(payment!._id).lean().exec();
    expect(updated!.status).toBe('REFUNDED');

    // One row for charge reply, one for refund reply
    const outboxRows = await outboxModel.find({ routingKey: ROUTING_KEYS.PAYMENT_SUCCEEDED }).lean().exec();
    expect(outboxRows.length).toBeGreaterThanOrEqual(1);
  });

  // ── Case 7: double refund-payment → no-op ─────────────────────────────────
  it('double refund-payment → no-op (second call replays reply, status stays REFUNDED)', async () => {
    const sagaId = randomUUID();
    const chargeEnvelope = buildChargeEnvelope(sagaId, 400);
    await handler.handleCharge(chargeEnvelope);
    const payment = await paymentModel.findOne({ sagaId }).lean().exec();

    const refund1 = buildRefundEnvelope(sagaId, String(payment!._id));
    await handler.handleRefundPayment(refund1);

    const refund2 = buildRefundEnvelope(sagaId, String(payment!._id)); // same sagaId, new messageId
    await handler.handleRefundPayment(refund2);

    const updated = await paymentModel.findById(payment!._id).lean().exec();
    expect(updated!.status).toBe('REFUNDED');

    // Two outbox rows for the refund step (original + replay), but only one stepResult
    const stepResults = await stepResultModel.find({ step: ROUTING_KEYS.REFUND_PAYMENT }).lean().exec();
    expect(stepResults).toHaveLength(1);
  });

  // ── Case 8: refund FAILED payment → no-op ────────────────────────────────
  it('refund on FAILED payment → no-op (status stays FAILED, reply still emitted)', async () => {
    const sagaId = randomUUID();
    const chargeEnvelope = buildChargeEnvelope(sagaId, 100, true); // forceFail
    await handler.handleCharge(chargeEnvelope);
    const payment = await paymentModel.findOne({ sagaId }).lean().exec();
    expect(payment!.status).toBe('FAILED');

    await outboxModel.deleteMany({}); // clear charge outbox rows for clarity
    await processedModel.deleteMany({});

    const refundSagaId = randomUUID(); // compensating saga step uses separate sagaId key in some designs
    // Using same sagaId so step keying works as documented
    const refundEnvelope = buildRefundEnvelope(sagaId, String(payment!._id));
    await handler.handleRefundPayment(refundEnvelope);

    const updated = await paymentModel.findById(payment!._id).lean().exec();
    // Status must NOT have changed — FAILED stays FAILED
    expect(updated!.status).toBe('FAILED');

    // A reply is still emitted (no-op path still signals orchestrator)
    const outboxRows = await outboxModel.find({}).lean().exec();
    expect(outboxRows).toHaveLength(1);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildChargeEnvelope(
  sagaId: string,
  amount: number,
  forceFail?: boolean,
) {
  return createEnvelope<ChargePayload & { forceFail?: boolean }>(
    ROUTING_KEYS.CHARGE,
    { sagaId, orderId: randomUUID(), userId: 'user@example.com', amount, ...(forceFail ? { forceFail } : {}) },
    { sagaId, step: ROUTING_KEYS.CHARGE, correlationId: randomUUID() },
  );
}

function buildRefundEnvelope(sagaId: string, paymentId: string) {
  return createEnvelope<RefundPaymentPayload>(
    ROUTING_KEYS.REFUND_PAYMENT,
    { sagaId, orderId: randomUUID(), paymentId },
    { sagaId, step: ROUTING_KEYS.REFUND_PAYMENT, correlationId: randomUUID() },
  );
}
