import { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  const replSet: MongoMemoryReplSet | undefined = (global as any).__SAGA_REPLSET__;
  await replSet?.stop();
}
