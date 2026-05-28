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
  CMD wget -qO- http://localhost:4000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "(./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema.prisma 2>&1 || echo 'migrate skipped'); node dist/main.js"]
