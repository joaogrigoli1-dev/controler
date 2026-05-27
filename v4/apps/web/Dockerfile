# ───────────────────────────────────────────
# Controler v4 Web — Dockerfile multi-stage (Next.js standalone)
# ───────────────────────────────────────────

FROM node:20-alpine AS build
WORKDIR /repo
RUN apk add --no-cache libc6-compat \
    && corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY . .
RUN pnpm install --no-frozen-lockfile

WORKDIR /repo/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build


FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache curl tini

ENV NODE_ENV=production
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
