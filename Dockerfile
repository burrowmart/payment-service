# ── Build stage ────────────────────────────────────────────────────────────────
# Build context: backend repo root  →  docker build -f payment-service/Dockerfile .
FROM node:20-alpine AS build

WORKDIR /workspace

# 1. Build the contracts package so the file: dep has a dist/ to resolve
COPY contracts/package*.json contracts/
RUN cd contracts && npm install --ignore-scripts

COPY contracts/src contracts/src
COPY contracts/scripts contracts/scripts
COPY contracts/openapi contracts/openapi
COPY contracts/tsconfig*.json contracts/
RUN cd contracts && npm run build

# 2. Install service deps
COPY payment-service/package*.json payment-service/
RUN cd payment-service && npm ci --ignore-scripts

# 3. Compile the service
COPY payment-service/src          payment-service/src
COPY payment-service/tsconfig*.json payment-service/
COPY payment-service/nest-cli.json  payment-service/
RUN cd payment-service && npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=build --chown=appuser:appgroup /workspace/payment-service/dist        ./dist
COPY --from=build --chown=appuser:appgroup /workspace/payment-service/node_modules ./node_modules
COPY --from=build --chown=appuser:appgroup /workspace/payment-service/package.json ./

# npm resolved the @demo/contracts `file:` dependency to a symlink pointing at
# the build stage's /workspace/contracts, which isn't part of this stage —
# replace it with the actual built package so the runtime require() resolves.
RUN rm -f node_modules/@demo/contracts
COPY --from=build --chown=appuser:appgroup /workspace/contracts/dist ./node_modules/@demo/contracts/dist
COPY --from=build --chown=appuser:appgroup /workspace/contracts/package.json ./node_modules/@demo/contracts/package.json

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/main"]
