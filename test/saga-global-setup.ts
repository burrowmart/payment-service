/**
 * Global setup for the payment saga integration test.
 * Starts a MongoMemoryReplSet (single-node RS) to enable Mongo transactions.
 * No RabbitMQ/Redis — handlers are called directly.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalSetup(): Promise<void> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, name: 'rs0' },
  });

  await replSet.waitUntilRunning();

  const uri = replSet.getUri('payment-saga-test');
  process.env.MONGO_URI = uri.includes('?')
    ? uri.replace('?', '?directConnection=true&')
    : `${uri}?directConnection=true`;

  process.env.PORT = '3003';
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.AUTH_DISABLED = 'true';
  // Default to no PSP failure threshold unless individual tests override via config mock
  process.env.FAIL_PAYMENT_OVER_AMOUNT = '0';

  (global as any).__SAGA_REPLSET__ = replSet;
}
