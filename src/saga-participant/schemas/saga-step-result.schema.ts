import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { MessageEnvelope } from '@demo/contracts';

export type SagaStepResultDocument = HydratedDocument<SagaStepResultEntity>;

/**
 * Persists the reply for a saga step keyed by (sagaId, step).
 * Enables idempotent replay: a redelivered command with the same sagaId+step
 * re-writes the cached envelope to the outbox without touching Payment again.
 */
@Schema({ collection: 'saga_step_results', timestamps: true })
export class SagaStepResultEntity {
  @Prop({ required: true })
  sagaId!: string;

  /** e.g. 'charge' or 'refund-payment' */
  @Prop({ required: true })
  step!: string;

  @Prop({ required: true })
  replyRoutingKey!: string;

  @Prop({ type: Object, required: true })
  replyEnvelope!: MessageEnvelope;
}

export const SagaStepResultSchema = SchemaFactory.createForClass(SagaStepResultEntity);

SagaStepResultSchema.index({ sagaId: 1, step: 1 }, { unique: true });
