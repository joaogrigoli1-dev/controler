# ───────────────────────────────────────────
# Controler v4 API — Dockerfile single-stage (pnpm-friendly)
# ───────────────────────────────────────────

FROM node:20-alpine
WORKDIR /repo
RUN apk add --no-cache openssh-client curl python3 make g++ openssl libc6-compat tini \
    && corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copia tudo (workspace requer todos os packages para resolver deps internas)
COPY . .

# Install + Prisma generate + build no mesmo lugar onde vai rodar
WORKDIR /repo/apps/api
RUN pnpm install --no-frozen-lockfile
RUN pnpm prisma generate
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "./node_modules/.bin/prisma db push --schema=./prisma/schema.prisma --skip-generate --accept-data-loss 2>&1 | tail -5; node dist/main.js"]
