import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentEntity, PaymentSchema } from '../payments/schemas/payment.schema';
import { PaymentsRepository } from '../payments/payments.repository';
import { OutboxModule } from '../common/outbox/outbox.module';
import { SagaStepResultEntity, SagaStepResultSchema } from './schemas/saga-step-result.schema';
import { PaymentSagaHandler } from './payment-saga.handler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentEntity.name, schema: PaymentSchema },
      { name: SagaStepResultEntity.name, schema: SagaStepResultSchema },
    ]),
    OutboxModule,
  ],
  providers: [PaymentSagaHandler, PaymentsRepository],
})
export class SagaParticipantModule {}
