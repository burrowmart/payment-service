/**
 * Jest globalSetup — runs once before any test file is loaded.
 * Starts MongoMemoryServer and exposes MONGO_URI via process.env so that
 * ConfigModule's Joi validation finds the variable when app.module.ts is
 * first imported (which happens at module-load time, before beforeAll).
 * Works because --runInBand keeps everything in the same process.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

export default async function globalSetup(): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = `${mongod.getUri()}payment-service-test`;
  process.env.PORT = '3001';
  // Disable RabbitMQ/Redis publisher in unit & standard e2e tests
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.AUTH_DISABLED = 'true';
  (global as any).__MONGOD__ = mongod;
}
