# How to Create a New Service from This Template

> **Follow this checklist exactly, in order.** Every item is mandatory.
> Future services (catalog, order, payment, notification, chat) use this verbatim.

---

## Legend

| Placeholder | Example |
|---|---|
| `{{svc}}` | `catalog-service` |
| `{{entity}}` | `products` (plural, lowercase) |
| `{{Entity}}` | `Product` (singular, PascalCase) |
| `{{collection}}` | `products` |
| `{{queue}}` | `catalog-service.queue` |
| `{{ingress-host}}` | `catalog-service.internal.archtenet.com` |
| `{{ingress-path}}` | `/api/v1/products` |
| `{{org}}` | `archtenet` |
| `{{aws-account}}` | `123456789012` |

---

## 1. Bootstrap

```bash
cp -r user-service {{svc}}
cd {{svc}}
rm -rf .git dist node_modules
git init && git remote add origin git@github.com:{{org}}/{{svc}}.git
```

---

## 2. `package.json`

| Field | Old value | New value |
|---|---|---|
| `name` | `@demo/user-service` | `@demo/{{svc}}` |

---

## 3. `src/constants.ts`  ← **Single source of truth**

This is the only file where the three core strings live.
All TypeScript consumers import from here — do not hardcode elsewhere.

| Constant | Old value | New value |
|---|---|---|
| `SERVICE_NAME` | `'user-service'` | `'{{svc}}'` |
| `MONGO_COLLECTION` | `'users'` | `'{{collection}}'` |
| `RABBITMQ_QUEUE` | `'user-service.queue'` | `'{{queue}}'` |

Changing these three propagates automatically to:
- `src/config/env.validation.ts` — `OTEL_SERVICE_NAME` Joi default
- `src/common/tracing/tracing.ts` — `service.name` SDK fallback
- `src/{{entity}}/schemas/{{entity}}.schema.ts` — `@Schema({ collection: … })`

---

## 4. `helm/Chart.yaml`

| Field | Old value | New value |
|---|---|---|
| `name` | `user-service` | `{{svc}}` |
| `description` | `User-service Helm chart…` | describe the new service |
| `keywords[1]` | `user-service` | `{{svc}}` |

---

## 5. `helm/values.yaml`

| Key path | Old value | New value |
|---|---|---|
| `base-service.fullnameOverride` | `"user-service"` | `"{{svc}}"` |
| `base-service.nameOverride` | `"user-service"` | `"{{svc}}"` |
| `base-service.image.repository` | `ghcr.io/archtenet/user-service` | `ghcr.io/archtenet/{{svc}}` |
| `base-service.app.env.RABBITMQ_QUEUE` | `user-service.queue` | `{{queue}}` |
| `base-service.app.env.OTEL_SERVICE_NAME` | `user-service` | `{{svc}}` |
| `base-service.ingress.host` | `user-service.internal.archtenet.com` | `{{ingress-host}}` |
| `base-service.ingress.path` | `/api/v1/users` | `{{ingress-path}}` |
| `base-service.secretsManagerPath` | `"/prod/user-service"` | `"/prod/{{svc}}"` |
| `base-service.irsaRoleArn` | `"…ACCOUNT_ID:role/user-service-irsa"` | `"arn:aws:iam::{{aws-account}}:role/{{svc}}-irsa"` |

---

## 6. `.github/workflows/ci.yml`

| Field | Old value | New value |
|---|---|---|
| `jobs.ci.with.service-name` | `user-service` | `{{svc}}` |
| `jobs.ci.with.helm-path` | `user-service/helm` | `{{svc}}/helm` |

---

## 7. `Dockerfile`

All `user-service/` path references are relative inside the multi-stage build.
No changes needed **if** the build context stays `backend/` repo root and you
rename only the directory.

If you rename the repo root folder, update every `COPY user-service/…` and
`RUN cd user-service` line to `{{svc}}`.

---

## 8. `.env.example`

| Line | Old value | New value |
|---|---|---|
| `MONGO_URI=…` | `…/user-service` | `…/{{collection}}` (DB name = collection) |
| `OTEL_SERVICE_NAME=` | `user-service` | `{{svc}}` |

---

## 9. `src/main.ts` — Swagger metadata

```ts
// Change both strings:
.setTitle('{{Entity}} Service API')
.setDescription('…')
```

---

## 10. Domain code — rename `src/users/` → `src/{{entity}}/`

```
src/users/          →  src/{{entity}}/
  users.controller.ts →  {{entity}}.controller.ts
  users.module.ts     →  {{entity}}.module.ts
  users.repository.ts →  {{entity}}.repository.ts
  users.service.ts    →  {{entity}}.service.ts
  dto/
    create-user.dto.ts  →  create-{{entity-singular}}.dto.ts
    update-user.dto.ts  →  update-{{entity-singular}}.dto.ts
  schemas/
    user.schema.ts      →  {{entity-singular}}.schema.ts
```

Rename all class names, `@Controller`, `@ApiTags` values, and `@InjectModel`
tokens to match the new entity.

---

## 11. `contracts/` — extend the shared package

All changes are in **`backend/contracts/`** (the monorepo's shared package).

| File | Action |
|---|---|
| `openapi/{{svc}}.yaml` | Create OpenAPI 3.1 spec for the new service |
| `scripts/generate-clients.ts` | Add `{{svc}}` to the generator list |
| `src/clients/{{svc}}.client.ts` | Create fetch-based client (run `npm run generate` after spec is done) |
| `src/clients/generated/{{svc}}.ts` | Auto-generated — commit after running generator |
| `src/clients/index.ts` | Add `export * from './{{svc}}.client';` |
| `src/dto/{{svc}}.dto.ts` | Create TS interface types (mirror OpenAPI schemas) |
| `src/dto/index.ts` | Add `export * from './{{svc}}.dto';` |
| `src/messages/events.ts` | Add `{{Entity}}CreatedPayload`, `{{Entity}}UpdatedPayload`, `{{Entity}}DeletedPayload` |
| `src/messages/queue-names.ts` | Add entries under `QUEUES` and `ROUTING_KEYS` for the new service's events |
| `src/index.ts` | No change needed (already re-exports `./dto` and `./messages`) |

After editing contracts:
```bash
cd backend/contracts && npm run build
```

---

## 12. Verification

Run these from inside `backend/{{svc}}/`:

```bash
npm run build                   # TypeScript compiles clean
npm test                        # unit tests pass
```

Run from repo root:
```bash
actionlint {{svc}}/.github/workflows/ci.yml
```

Helm dry-run:
```bash
helm dependency update {{svc}}/helm
helm template {{svc}} {{svc}}/helm --dry-run
```

---

## Summary checklist

- [ ] `package.json` → `name`
- [ ] `src/constants.ts` → `SERVICE_NAME`, `MONGO_COLLECTION`, `RABBITMQ_QUEUE`
- [ ] `helm/Chart.yaml` → `name`, `description`, `keywords`
- [ ] `helm/values.yaml` → all 9 fields (§5)
- [ ] `.github/workflows/ci.yml` → `service-name`, `helm-path`
- [ ] `Dockerfile` → directory references (if root renamed)
- [ ] `.env.example` → `MONGO_URI`, `OTEL_SERVICE_NAME`
- [ ] `src/main.ts` → Swagger title & description
- [ ] `src/users/` → rename to `src/{{entity}}/`, update all class names
- [ ] `contracts/` → all 8 files listed in §11
- [ ] `contracts/` → `npm run build` green
- [ ] `npm run build && npm test` green in `{{svc}}/`
- [ ] `actionlint` green on `ci.yml`
