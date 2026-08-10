/**
 * MongoMemoryServer is started by test/global-setup.ts before any file is
 * imported, so MONGO_URI is already in process.env when ConfigModule.forRoot
 * validates the schema at app.module.ts parse time.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('PaymentsController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health → 200', () =>
    request(app.getHttpServer())
      .get('/health')
      .expect(200, { status: 'ok' }));

  it('GET /payments → 200 with empty paginated result', () =>
    request(app.getHttpServer())
      .get('/payments')
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body).toMatchObject({ data: [], total: 0, page: 1, limit: 20 });
      }));

  it('GET /payments/:id with non-existent id → 404', () =>
    request(app.getHttpServer())
      .get('/payments/000000000000000000000000')
      .expect(404));
});
