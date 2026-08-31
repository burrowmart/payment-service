export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  mongoUri: process.env.MONGO_URI as string,
  rabbitmqUrl: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  outboxPublisherEnabled: process.env.OUTBOX_PUBLISHER_ENABLED !== 'false',
  // PSP simulation: charges above this amount (in cents) auto-fail. 0 = disabled.
  failPaymentOverAmount: parseInt(process.env.FAIL_PAYMENT_OVER_AMOUNT ?? '0', 10),
});
