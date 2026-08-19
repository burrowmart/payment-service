import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { randomUUID } from 'crypto';
import { context, propagation } from '@opentelemetry/api';
import type { MessageEnvelope } from '@demo/contracts';
import { getCorrelationId } from '../correlation/correlation.context';
import { OutboxEntity, OutboxDocument } from './schemas/outbox.schema';

@Injectable()
export class OutboxService {
  constructor(
    @InjectModel(OutboxEntity.name)
    private readonly model: Model<OutboxDocument>,
  ) {}

  /**
   * Writes one outbox row inside the caller's already-open Mongo session.
   * Must be called before the caller commits the session so that the domain
   * write and the outbox insert are atomic.
   *
   * correlationId is auto-populated from the AsyncLocalStorage request context
   * when not explicitly set on the envelope.
   */
  async writeInTx(
    session: ClientSession,
    envelope: MessageEnvelope,
    exchange: string,
    routingKey: string,
  ): Promise<void> {
    const enriched: MessageEnvelope = {
      ...envelope,
      correlationId:
        envelope.correlationId || getCorrelationId() || randomUUID(),
    };
    // Capture the live trace context now -- writeInTx is the only point in
    // the outbox flow that still runs inside the original request's async
    // context. OutboxPublisherService re-attaches this as an AMQP header
    // when it actually publishes, later and from a different async context
    // (see the field comment on OutboxEntity.traceparent).
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    await this.model.create(
      [
        {
          envelope: enriched,
          exchange,
          routingKey,
          published: false,
          traceparent: carrier.traceparent,
        },
      ],
      { session },
    );
  }
}
