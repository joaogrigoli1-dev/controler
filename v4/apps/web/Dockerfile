# ───────────────────────────────────────────
# Controler v4 Web — Dockerfile multi-stage (Next.js standalone)
# ───────────────────────────────────────────

FROM node:20-alpine AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/

RUN pnpm install --frozen-lockfile=false


FROM deps AS build
COPY apps/web apps/web
COPY packages packages
WORKDIR /repo/apps/web
RUN pnpm build


FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache curl tini

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
