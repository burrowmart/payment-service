import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection } from 'mongoose';
import * as amqplib from 'amqplib';
import { ConfigService } from '@nestjs/config';
import {
  createEnvelope,
  EXCHANGES,
  QUEUES,
  ROUTING_KEYS,
} from '@demo/contracts';
import type {
  MessageEnvelope,
  ChargePayload,
  RefundPaymentPayload,
  PaymentSucceededPayload,
  PaymentFailedPayload,
  PaymentSucceededEventPayload,
  PaymentFailedEventPayload,
} from '@demo/contracts';
import { OutboxService } from '../common/outbox/outbox.service';
import { IdempotentConsumerService } from '../common/outbox/idempotent-consumer.service';
import { context, propagation } from '@opentelemetry/api';
import { correlationStorage } from '../common/correlation/correlation.context';
import { PaymentEntity, PaymentDocument } from '../payments/schemas/payment.schema';
import { PaymentsRepository } from '../payments/payments.repository';
import {
  SagaStepResultEntity,
  SagaStepResultDocument,
} from './schemas/saga-step-result.schema';

/** ChargePayload extended with the optional demo-only forceFail flag */
interface ChargePayloadWithFlag extends ChargePayload {
  forceFail?: boolean;
}

@Injectable()
export class PaymentSagaHandler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PaymentSagaHandler.name);
  private amqpConn?: amqplib.ChannelModel;
  private chargeCh?: amqplib.Channel;
  private refundCh?: amqplib.Channel;

  constructor(
    @InjectModel(SagaStepResultEntity.name)
    private readonly stepResultModel: Model<SagaStepResultDocument>,
    @InjectModel(PaymentEntity.name)
    private readonly paymentModel: Model<PaymentDocument>,
    @InjectConnection() private readonly conn: Connection,
    private readonly paymentsRepo: PaymentsRepository,
    private readonly outbox: OutboxService,
    private readonly idempotentConsumer: IdempotentConsumerService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get<boolean>('outboxPublisherEnabled')) {
      this.logger.log('Saga participant consumer disabled (outboxPublisherEnabled=false)');
      return;
    }
    await this.startConsuming();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.chargeCh?.close().catch(() => undefined);
    await this.refundCh?.close().catch(() => undefined);
    await this.amqpConn?.close().catch(() => undefined);
  }

  /** Exposed for integration tests — call directly without AMQP. */
  async handleCharge(envelope: MessageEnvelope<ChargePayloadWithFlag>): Promise<void> {
    const result = await this.idempotentConsumer.handle(envelope, async (payload) => {
      await this.processCharge(envelope, payload);
    });
    this.logger.debug({ messageId: envelope.messageId, result }, 'charge handled');
  }

  /** Exposed for integration tests — call directly without AMQP. */
  async handleRefundPayment(envelope: MessageEnvelope<RefundPaymentPayload>): Promise<void> {
    const result = await this.idempotentConsumer.handle(envelope, async (payload) => {
      await this.processRefund(envelope, payload);
    });
    this.logger.debug({ messageId: envelope.messageId, result }, 'refund-payment handled');
  }

  // ── Private handlers ──────────────────────────────────────────────────────

  private async processCharge(
    envelope: MessageEnvelope<ChargePayloadWithFlag>,
    payload: ChargePayloadWithFlag,
  ): Promise<void> {
    const { sagaId, orderId, userId, amount, forceFail } = payload;
    const step = ROUTING_KEYS.CHARGE;

    // Level-2 idempotency: same sagaId+step → replay cached outcome
    const existing = await this.stepResultModel.findOne({ sagaId, step }).lean().exec();
    if (existing) {
      this.logger.debug({ sagaId, step }, 'Charge step already processed — replaying reply');
      await this.replayReply(existing as SagaStepResultDocument);
      return;
    }

    // PSP simulation: fail if forceFail flag set or amount exceeds configured threshold
    const failThreshold = this.config.get<number>('failPaymentOverAmount') ?? 0;
    const shouldFail = forceFail === true || (failThreshold > 0 && amount > failThreshold);

    const session = await this.conn.startSession();
    try {
      await session.withTransaction(async () => {
        const status = shouldFail ? 'FAILED' : 'SUCCEEDED';
        const payment = await this.paymentsRepo.create(
          { orderId, sagaId, userId, amount, status },
          session,
        );

        const reason = forceFail ? 'forceFail flag set' : `Amount ${amount} exceeds limit ${failThreshold}`;

        let replyEnvelope: MessageEnvelope;
        let replyRoutingKey: string;

        if (shouldFail) {
          replyEnvelope = createEnvelope<PaymentFailedPayload>(
            ROUTING_KEYS.PAYMENT_FAILED,
            { sagaId, orderId, reason },
            { sagaId, step, correlationId: envelope.correlationId },
          );
          replyRoutingKey = ROUTING_KEYS.PAYMENT_FAILED;
        } else {
          replyEnvelope = createEnvelope<PaymentSucceededPayload>(
            ROUTING_KEYS.PAYMENT_SUCCEEDED,
            { sagaId, orderId, paymentId: String(payment._id) },
            { sagaId, step, correlationId: envelope.correlationId },
          );
          replyRoutingKey = ROUTING_KEYS.PAYMENT_SUCCEEDED;
        }

        await this.stepResultModel.create(
          [{ sagaId, step, replyRoutingKey, replyEnvelope }],
          { session },
        );

        // Private reply to the order-orchestrator (drives saga state transitions)
        await this.outbox.writeInTx(session, replyEnvelope, EXCHANGES.SAGA_REPLIES, replyRoutingKey);

        // Public choreography event for notification-service (and any other
        // future subscriber) — same transaction, so it's exactly-once with the
        // orchestrator reply above. Not emitted from processRefund: a refund is
        // a saga compensation, not a new "payment succeeded" business fact.
        const notifyEnvelope = shouldFail
          ? createEnvelope<PaymentFailedEventPayload>(
              ROUTING_KEYS.PAYMENT_FAILED,
              { sagaId, orderId, userId, reason },
              { sagaId, step, correlationId: envelope.correlationId },
            )
          : createEnvelope<PaymentSucceededEventPayload>(
              ROUTING_KEYS.PAYMENT_SUCCEEDED,
              { sagaId, orderId, userId, paymentId: String(payment._id) },
              { sagaId, step, correlationId: envelope.correlationId },
            );
        await this.outbox.writeInTx(session, notifyEnvelope, EXCHANGES.DOMAIN_EVENTS, replyRoutingKey);
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        this.logger.debug({ sagaId, step }, 'Concurrent charge insert — fetching existing result');
        const concurrent = await this.stepResultModel.findOne({ sagaId, step }).lean().exec();
        if (concurrent) await this.replayReply(concurrent as SagaStepResultDocument);
        return;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  private async processRefund(
    envelope: MessageEnvelope<RefundPaymentPayload>,
    payload: RefundPaymentPayload,
  ): Promise<void> {
    const { sagaId, orderId, paymentId } = payload;
    const step = ROUTING_KEYS.REFUND_PAYMENT;

    // Level-2 idempotency: same sagaId+step → replay
    const existing = await this.stepResultModel.findOne({ sagaId, step }).lean().exec();
    if (existing) {
      this.logger.debug({ sagaId, step }, 'Refund already processed — replaying reply');
      await this.replayReply(existing as SagaStepResultDocument);
      return;
    }

    const payment = await this.paymentModel.findById(paymentId).lean().exec();

    // No-op cases: refunding FAILED payment or non-existent payment — log and reply same success envelope
    if (!payment || payment.status === 'FAILED') {
      this.logger.log(
        { sagaId, paymentId, currentStatus: payment?.status },
        'Refund no-op — payment is FAILED or not found; emitting same reply without DB change',
      );
    }

    const session = await this.conn.startSession();
    try {
      await session.withTransaction(async () => {
        // Only actually update if the payment exists and is not already FAILED/REFUNDED
        if (payment && payment.status !== 'FAILED' && payment.status !== 'REFUNDED') {
          await this.paymentsRepo.updateStatus(paymentId, 'REFUNDED', session);
        }

        // Always emit refund-acknowledged reply so orchestrator can advance
        const replyEnvelope = createEnvelope<PaymentSucceededPayload>(
          ROUTING_KEYS.PAYMENT_SUCCEEDED,
          { sagaId, orderId, paymentId },
          { sagaId, step, correlationId: envelope.correlationId },
        );
        const replyRoutingKey = ROUTING_KEYS.PAYMENT_SUCCEEDED;

        await this.stepResultModel.create(
          [{ sagaId, step, replyRoutingKey, replyEnvelope }],
          { session },
        );

        await this.outbox.writeInTx(session, replyEnvelope, EXCHANGES.SAGA_REPLIES, replyRoutingKey);
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        const concurrent = await this.stepResultModel.findOne({ sagaId, step }).lean().exec();
        if (concurrent) await this.replayReply(concurrent as SagaStepResultDocument);
        return;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /** Re-writes the cached reply envelope to the outbox; same messageId lets the orchestrator deduplicate. */
  private async replayReply(stepResult: SagaStepResultDocument): Promise<void> {
    const session = await this.conn.startSession();
    try {
      await session.withTransaction(async () => {
        await this.outbox.writeInTx(
          session,
          stepResult.replyEnvelope,
          EXCHANGES.SAGA_REPLIES,
          stepResult.replyRoutingKey,
        );
      });
    } finally {
      await session.endSession();
    }
  }

  private async startConsuming(): Promise<void> {
    const url = this.config.get<string>('rabbitmqUrl')!;
    this.amqpConn = await amqplib.connect(url);

    const setupCh = await this.amqpConn.createChannel();
    await setupCh.assertExchange(EXCHANGES.SAGA_COMMANDS, 'direct', { durable: true });
    // Publish-only exchange for this service's replies — the reply *queues*
    // (order.payment-succeeded/-failed) are order-service's own
    // SagaRepliesConsumerService's exclusive concern: it declares them with
    // x-dead-letter-exchange args and consumes them. Re-declaring them here
    // with different (bare) arguments causes RabbitMQ to reject the assert
    // with 406 PRECONDITION_FAILED once order-service has already declared
    // them, crashing this connection — so this service must only assert the
    // exchange, never the reply queues.
    await setupCh.assertExchange(EXCHANGES.SAGA_REPLIES, 'direct', { durable: true });
    await setupCh.assertQueue(QUEUES.CHARGE, { durable: true });
    await setupCh.assertQueue(QUEUES.REFUND_PAYMENT, { durable: true });
    await setupCh.bindQueue(QUEUES.CHARGE, EXCHANGES.SAGA_COMMANDS, ROUTING_KEYS.CHARGE);
    await setupCh.bindQueue(QUEUES.REFUND_PAYMENT, EXCHANGES.SAGA_COMMANDS, ROUTING_KEYS.REFUND_PAYMENT);
    await setupCh.close();

    this.chargeCh = await this.amqpConn.createChannel();
    await this.chargeCh.prefetch(1);
    await this.chargeCh.consume(QUEUES.CHARGE, async (msg) => {
      if (!msg) return;
      const envelope: MessageEnvelope<ChargePayloadWithFlag> = JSON.parse(msg.content.toString());
      try {
        // Run in the correlation ALS context so this handler's (and mixin-emitted) log
        // lines carry the originating request's cf-ray/x-correlation-id — the AMQP
        // consume path otherwise never enters an ALS context (unlike HTTP requests).
        const traceCtx = propagation.extract(context.active(), msg.properties.headers ?? {});
        await context.with(traceCtx, () => correlationStorage.run({ correlationId: envelope.correlationId }, async () => {
          this.logger.log(
            { correlationId: envelope.correlationId, sagaId: envelope.sagaId },
            'charge command received',
          );
          await this.handleCharge(envelope);
        }));
        this.chargeCh!.ack(msg);
      } catch (err) {
        this.logger.error({ err }, 'charge handler error — nacking');
        this.chargeCh!.nack(msg, false, true);
      }
    });

    this.refundCh = await this.amqpConn.createChannel();
    await this.refundCh.prefetch(1);
    await this.refundCh.consume(QUEUES.REFUND_PAYMENT, async (msg) => {
      if (!msg) return;
      const envelope: MessageEnvelope<RefundPaymentPayload> = JSON.parse(msg.content.toString());
      try {
        const traceCtx = propagation.extract(context.active(), msg.properties.headers ?? {});
        await context.with(traceCtx, () => correlationStorage.run({ correlationId: envelope.correlationId }, async () => {
          this.logger.log(
            { correlationId: envelope.correlationId, sagaId: envelope.sagaId },
            'refund-payment command received',
          );
          await this.handleRefundPayment(envelope);
        }));
        this.refundCh!.ack(msg);
      } catch (err) {
        this.logger.error({ err }, 'refund-payment handler error — nacking');
        this.refundCh!.nack(msg, false, true);
      }
    });

    this.logger.log('Payment saga participant consuming charge + refund-payment queues');
  }
}
