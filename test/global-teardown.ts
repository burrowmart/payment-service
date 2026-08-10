import type { MongoMemoryServer } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  const mongod: MongoMemoryServer | undefined = (global as any).__MONGOD__;
  await mongod?.stop();
}
