# ───────────────────────────────────────────
# Controler v4 API — Dockerfile multi-stage
# ───────────────────────────────────────────

FROM node:20-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache openssh-client curl
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile=false


FROM deps AS build
COPY apps/api apps/api
COPY packages/shared packages/shared
WORKDIR /repo/apps/api
RUN pnpm prisma generate
RUN pnpm build


FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssh-client curl tini && corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/node_modules ./node_modules
COPY --from=build /repo/apps/api/prisma ./prisma
COPY --from=build /repo/apps/api/package.json ./package.json

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
