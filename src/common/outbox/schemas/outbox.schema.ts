import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { MessageEnvelope } from '@demo/contracts';

export type OutboxDocument = HydratedDocument<OutboxEntity>;

@Schema({ timestamps: true, collection: 'outbox' })
export class OutboxEntity {
  @Prop({ type: Object, required: true })
  envelope!: MessageEnvelope;

  /** RabbitMQ exchange name (from EXCHANGES constants) */
  @Prop({ required: true })
  exchange!: string;

  /** RabbitMQ routing key (from ROUTING_KEYS constants) */
  @Prop({ required: true })
  routingKey!: string;

  @Prop({ default: false, index: true })
  published!: boolean;

  @Prop()
  publishedAt?: Date;

  /**
   * W3C traceparent captured from the active OTel span when this row was
   * written (see OutboxService.writeInTx) -- NOT part of the wire envelope.
   * OutboxPublisherService republishes it as an AMQP header at publish time:
   * the change-stream callback that drives publishing has no span of its
   * own (it runs decoupled from the original request), so without this the
   * RabbitMQ hop would silently start a new, disconnected trace instead of
   * continuing the request's.
   */
  @Prop()
  traceparent?: string;
}

export const OutboxSchema = SchemaFactory.createForClass(OutboxEntity);
// Compound index: efficient backlog drain query (published: false, sorted by age)
OutboxSchema.index({ published: 1, createdAt: 1 });
