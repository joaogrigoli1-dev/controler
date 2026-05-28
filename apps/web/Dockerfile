# ───────────────────────────────────────────
# Controler v4 Web — Dockerfile single-stage (Next.js sem standalone)
# ───────────────────────────────────────────

FROM node:20-alpine
WORKDIR /repo
RUN apk add --no-cache curl tini libc6-compat \
    && corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY . .
RUN pnpm install --no-frozen-lockfile

WORKDIR /repo/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "start"]
