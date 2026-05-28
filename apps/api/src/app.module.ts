import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";

import { CommonModule } from "./common/common.module";
import { AuthModule } from "./auth/auth.module";
import { Srv1Module } from "./srv1/srv1.module";
import { CoolifyModule } from "./coolify/coolify.module";
import { HestiaModule } from "./hestia/hestia.module";
import { VaultModule } from "./vault/vault.module";
import { AlertsModule } from "./alerts/alerts.module";
import { ScannerModule } from "./scanner/scanner.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { TimelineModule } from "./timeline/timeline.module";
import { DeploysModule } from "./deploys/deploys.module";
import { ApisModule } from "./apis/apis.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { UsersModule } from "./users/users.module";
import { HealthController } from "./common/health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Throttler granular: 3 named groups que controllers usam via @Throttle({ short: { ... } })
    ThrottlerModule.forRoot([
      { name: "short", ttl: 60_000, limit: 60 },     // 60/min — default p/ rotas auth-protected
      { name: "auth", ttl: 60_000, limit: 5 },       // 5/min — rotas de auth (request-code, verify-code, refresh)
      { name: "sensitive", ttl: 60_000, limit: 10 }  // 10/min — vault reveal, restart container, deploy
    ]),
    CommonModule,
    AuthModule,
    UsersModule,
    Srv1Module,
    CoolifyModule,
    HestiaModule,
    VaultModule,
    AlertsModule,
    ScannerModule,
    RealtimeModule,
    TimelineModule,
    DeploysModule,
    ApisModule,
    AnalyticsModule
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard }
  ]
})
export class AppModule {}
