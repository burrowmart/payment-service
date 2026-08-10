import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { PaymentStatus } from '@demo/contracts';
import { MONGO_COLLECTION } from '../../constants';

export type PaymentDocument = HydratedDocument<PaymentEntity>;

@Schema({ timestamps: true, collection: MONGO_COLLECTION })
export class PaymentEntity {
  @Prop({ required: true, index: true })
  orderId!: string;

  /** Saga correlation key — used for level-2 idempotency in the charge step */
  @Prop({ required: true, unique: true, index: true })
  sagaId!: string;

  /** User email — primary key from user-service */
  @Prop({ required: true })
  userId!: string;

  /** Amount in smallest currency unit (e.g. cents) */
  @Prop({ required: true })
  amount!: number;

  @Prop({ required: true, enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] })
  status!: PaymentStatus;
}

export const PaymentSchema = SchemaFactory.createForClass(PaymentEntity);
