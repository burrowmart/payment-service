import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { HealthController } from './health/health.controller';
import { PaymentsModule } from './payments/payments.module';
import { SagaParticipantModule } from './saga-participant/saga-participant.module';
import { CommonModule } from './common/common.module';
import { RayIdMiddleware } from './common/tracing/ray-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
    }),
    MongooseModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('mongoUri'),
      }),
      inject: [ConfigService],
    }),
    CommonModule,
    PaymentsModule,
    SagaParticipantModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RayIdMiddleware).forRoutes('*');
  }
}
