# payment-service

## Architecture

`payment-service` is the **payment processor** for the @demo platform. It participates in the
order-placement saga as the charge step and owns the `payments` MongoDB collection.

- Owns the `payments` MongoDB collection.
- Saga participant: handles `charge` (create Payment + reply `payment-succeeded` | `payment-failed`)
  and `refund-payment` compensation (mark REFUNDED + reply).
- Idempotent by `sagaId + step`: a redelivered command replays the stored outcome without creating
  a second Payment document.
- PSP simulation: set `FAIL_PAYMENT_OVER_AMOUNT` (cents) to auto-fail large charges; pass
  `forceFail: true` in the command payload to force failure in tests.
- REST: `GET /payments` (with optional `orderId` / `userId` filter), `GET /payments/:id`.
- Auth enforced by the global `JwtGuard` in `CommonModule` — Cognito JWTs verified against JWKS.

### What this service owns

| Resource | Type | Notes |
|----------|------|-------|
| `payments` | MongoDB collection | `sagaId` unique index prevents double-charge |
| `saga_step_results` | MongoDB collection | level-2 idempotency key: `(sagaId, step)` |
| `outbox` | MongoDB collection | transactional outbox; marked `published: true` after delivery |
| `payment.charge` | RabbitMQ queue | bound to `saga.commands` exchange |
| `payment.refund-payment` | RabbitMQ queue | bound to `saga.commands` exchange (compensation) |
| `order.payment-succeeded` | RabbitMQ queue | reply queue consumed by order-orchestrator |
| `order.payment-failed` | RabbitMQ queue | reply queue consumed by order-orchestrator |

### Saga flow

```
order-orchestrator  →  charge command  →  payment.charge queue
                                                  ↓
                                        PaymentSagaHandler
                                          ↓           ↓
                                    [idempotent check (sagaId+step)]
                                          ↓
                                    Mongo transaction:
                                      Payment.create(SUCCEEDED|FAILED)
                                      SagaStepResult.create
                                      outbox.write(payment-succeeded|payment-failed)
                                          ↓
                                    OutboxPublisher → saga.replies exchange
                                          ↓
                                    order-orchestrator reply queue
```

Compensation (`refund-payment`): marks Payment `REFUNDED` in a transaction; refunding a `FAILED`
payment or refunding twice is a no-op — the handler logs and replays the cached reply.

### Request flow (REST)

```
Client → GET /payments?orderId=…
         ↓
Envoy PEP sidecar  (ext_authz → OPA)
         ↓
JwtGuard           (Cognito JWKS verification)
         ↓
PaymentsController (ValidationPipe)
         ↓
PaymentsService    (pagination + filtering)
         ↓
MongoDB payments collection
```

---

## Running locally

### Prerequisites

```bash
# 1. Build the shared contracts package
cd ../contracts && npm install && npm run build && cd -

# 2. Install service dependencies (copy node_modules from user-service, then fix symlink)
cp -r ../user-service/node_modules .
rm -rf node_modules/node_modules node_modules/@demo/contracts
ln -s ../../../contracts node_modules/@demo/contracts
cp -r ../catalog-service/node_modules/.cache node_modules/

# 3. Copy env and start the Mongo + Redis + RabbitMQ compose stack
cp .env.example .env
docker compose -f ../platform-infra/docker-compose.yml up -d
```

### Start in dev mode

```bash
npm run start:dev
# Service listens on http://localhost:3000
# Swagger UI at    http://localhost:3000/api
```

### Build

```bash
npm run build
# Output in dist/
```

### Tests

```bash
# Unit tests (no external deps)
npm test

# E2E tests (mongodb-memory-server, no compose required)
npm run test:e2e

# Saga idempotency tests (mongodb-memory-server, no compose required)
# Covers: duplicate charge, forceFail, FAIL_PAYMENT_OVER_AMOUNT, double refund, refund-on-FAILED
npm run test:saga

# Outbox integration tests (requires Docker: RabbitMQ + Redis)
npm run test:outbox
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_URI` | *(required)* | MongoDB connection string (replica set required for transactions) |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | RabbitMQ connection |
| `REDIS_URL` | `redis://localhost:6379` | Redis for outbox leader lock |
| `FAIL_PAYMENT_OVER_AMOUNT` | `0` | PSP simulation: auto-fail charges above this amount in cents; `0` = disabled |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | Set `false` to disable the change-stream publisher (unit/saga tests) |
| `AUTH_DISABLED` | `false` | Set `true` to bypass JWT guard in local/test environments |

### curl round-trip

```bash
BASE=http://localhost:3000

# List all payments
curl -s "$BASE/payments" | jq

# Filter by orderId
curl -s "$BASE/payments?orderId=<orderId>" | jq

# Get by id
curl -s "$BASE/payments/<id>" | jq
```

### Verifying the transactional outbox

After a `charge` command is processed, an outbox row is atomically written in the same Mongo
transaction. The outbox publisher delivers it to `saga.replies` exchange and marks it `published: true`.

**1. Check MongoDB**

```bash
mongosh "mongodb://localhost:27017/payment-service?replicaSet=rs0&directConnection=true" \
  --eval 'db.outbox.find({}, {routingKey:1, published:1, publishedAt:1}).pretty()'
```

**2. Check RabbitMQ**

Open http://localhost:15672 (guest / guest) → **Queues** → `order.payment-succeeded` → **Get Messages**.

**3. Check the service logs**

```
Outbox row published  { messageId: '...', type: 'payment-succeeded' }
```
