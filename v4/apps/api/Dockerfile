# ───────────────────────────────────────────
# Controler v4 API — Dockerfile multi-stage
# ───────────────────────────────────────────

FROM node:20-alpine AS build
WORKDIR /repo
RUN apk add --no-cache openssh-client curl python3 make g++ openssl libc6-compat \
    && corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copia tudo (workspace requer todos os packages para resolver deps internas)
COPY . .

# Install
RUN pnpm install --no-frozen-lockfile

# Generate Prisma + build
WORKDIR /repo/apps/api
RUN pnpm prisma generate
RUN pnpm build


FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssh-client curl tini openssl libc6-compat \
    && corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/node_modules ./node_modules
COPY --from=build /repo/apps/api/prisma ./prisma
COPY --from=build /repo/apps/api/package.json ./package.json
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages /repo/packages

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy --schema=./prisma/schema.prisma || true; node dist/main.js"]
