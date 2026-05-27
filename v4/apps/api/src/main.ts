import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { ValidationPipe, Logger } from "@nestjs/common";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, logger: false })
  );

  await app.register(helmet as any, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        frameAncestors: ["'none'"]
      }
    }
  });

  await app.register(cors as any, {
    origin: (origin: any, cb: any) => {
      const allowed = [
        /^http:\/\/localhost(:\d+)?$/,
        /^https?:\/\/controler(-v4)?\.net\.br$/
      ];
      if (!origin || allowed.some(rx => rx.test(origin))) return cb(null, true);
      cb(new Error("CORS blocked"), false);
    },
    credentials: true
  });

  await app.register(rateLimit as any, {
    max: 200,
    timeWindow: "1 minute",
    keyGenerator: (req: any) => req.headers["x-forwarded-for"]?.toString() || req.ip
  });

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix("api", { exclude: ["health", "/"] });

  const port = parseInt(process.env.PORT || "4000", 10);
  await app.listen(port, "0.0.0.0");
  Logger.log(`🚀 Controler v4 API listening on :${port}`, "Bootstrap");
}

bootstrap().catch(err => {
  console.error("[fatal]", err);
  process.exit(1);
});
