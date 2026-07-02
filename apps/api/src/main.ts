import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { ValidationPipe, Logger } from "@nestjs/common";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { AppModule } from "./app.module";

/** BE-09: falha no boot se secrets críticos estiverem ausentes/fracos — nunca subir com fallback. */
function assertRequiredEnv() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_ACCESS_SECRET ausente ou com menos de 32 chars. " +
      "Configure via SSM (/controler/*) antes de subir a API."
    );
  }
  if (process.env.NODE_ENV === "production" && process.env.DEV_BACKDOOR_TOKEN) {
    Logger.warn("DEV_BACKDOOR_TOKEN setada em produção — o endpoint /auth/dev-otp permanece BLOQUEADO (BE-03).", "Security");
  }
}

async function bootstrap() {
  assertRequiredEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, logger: false })
  );

  await app.register(helmet as any, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Next injeta estilos inline
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        frameAncestors: ["'none'"],
        // A-02: hardening adicional
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameSrc: ["'none'"],
        ...(process.env.NODE_ENV === "production" ? { upgradeInsecureRequests: [] } : {})
      }
    },
    crossOriginEmbedderPolicy: false
  });

  await app.register(cors as any, {
    origin: (origin: any, cb: any) => {
      const allowed = [
        /^http:\/\/localhost(:\d+)?$/,
        /^https?:\/\/(noc\.controler|painel\.controler|controler)\.net\.br$/,
        /^https?:\/\/[a-z0-9-]+\.62\.72\.63\.18\.sslip\.io$/
      ];
      if (!origin || allowed.some(rx => rx.test(origin))) return cb(null, true);
      cb(new Error("CORS blocked"), false);
    },
    credentials: true
  });

  // Rate limit global (catch-all) + por rota crítica
  // Convenção: usa X-Forwarded-For (Coolify Traefik) > X-Real-IP > req.ip
  const ipKey = (req: any) =>
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.headers["x-real-ip"]?.toString() ||
    req.ip;

  await app.register(rateLimit as any, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: ipKey,
    errorResponseBuilder: (req: any, ctx: any) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Limite ${ctx.max}/${ctx.after} excedido. Tente novamente em ${Math.ceil(ctx.ttl / 1000)}s.`,
      retryAfter: Math.ceil(ctx.ttl / 1000)
    }),
    skipOnError: true,
    // Per-route customization: rotas mais sensíveis ganham limites menores
    onExceeding: (req: any) => {
      Logger.warn(`[RATE_LIMIT] near limit ip=${ipKey(req)} path=${req.url}`, "RateLimit");
    },
    onExceeded: (req: any) => {
      Logger.error(`[RATE_LIMIT] EXCEEDED ip=${ipKey(req)} path=${req.url}`, "RateLimit");
    }
  });

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix("api", { exclude: ["health", "/"] });

  // Warning visível se backdoor admin estiver habilitado em prod
  if (process.env.DEV_BACKDOOR_TOKEN) {
    Logger.warn(
      `⚠ DEV_BACKDOOR_TOKEN está SET. Endpoint /be/auth/dev-otp ativo. ` +
      `Remova essa env var quando OTP estiver 100% confiável.`,
      "Security"
    );
  }

  const port = parseInt(process.env.PORT || "4000", 10);
  await app.listen(port, "0.0.0.0");
  Logger.log(`🚀 Controler v4 API listening on :${port}`, "Bootstrap");
}

bootstrap().catch(err => {
  console.error("[fatal]", err);
  process.exit(1);
});
