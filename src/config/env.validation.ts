import * as Joi from 'joi';
import { SERVICE_NAME } from '../constants';

export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  MONGO_URI: Joi.string().required(),
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  AUTH_DISABLED: Joi.string().valid('true', 'false').default('false'),
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().uri().optional(),
  OTEL_SERVICE_NAME: Joi.string().default(SERVICE_NAME),
  RABBITMQ_URL: Joi.string().default('amqp://guest:guest@localhost:5672'),
  REDIS_URL: Joi.string().default('redis://localhost:6379'),
  OUTBOX_PUBLISHER_ENABLED: Joi.string().valid('true', 'false').default('true'),
  // PSP simulation: auto-fail charges above this amount in cents; 0 = disabled
  FAIL_PAYMENT_OVER_AMOUNT: Joi.number().integer().min(0).default(0),
});
