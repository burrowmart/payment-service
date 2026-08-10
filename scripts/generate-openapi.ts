/**
 * Generates openapi.yaml from the NestJS Swagger module metadata.
 *
 * Prerequisites:
 *   - MongoDB must be reachable at MONGO_URI (or set env before running).
 *   - Run from the user-service directory: npm run generate:openapi
 *
 * The emitted openapi.yaml is committed to the repo and consumed by the
 * contracts package client generator.
 */
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { AppModule } from '../src/app.module';

// Default to localhost so the script is runnable without compose
process.env.MONGO_URI ??= 'mongodb://localhost:27017/user-service';

async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });

  const config = new DocumentBuilder()
    .setTitle('User Service API')
    .setDescription('Manages user profiles and OPAL attribute data. Email is the primary key.')
    .setVersion('0.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const outPath = join(__dirname, '..', 'openapi.yaml');
  writeFileSync(outPath, yaml.dump(document, { lineWidth: 120, noRefs: true }));
  console.log(`openapi.yaml written to ${outPath}`);

  await app.close();
  // Force exit in case Mongoose connection is still pending
  process.exit(0);
}

generate().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
