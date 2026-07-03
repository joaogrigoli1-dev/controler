import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { RollupService } from "./rollup.service";
import { PurgeService } from "./purge.service";
import { AuthModule } from "../auth/auth.module";
import { CoolifyModule } from "../coolify/coolify.module";

@Module({
  // FASE 3: CoolifyModule p/ o sinal "errors" do /analytics/health (apps exited)
  imports: [AuthModule, CoolifyModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, RollupService, PurgeService]
})
export class AnalyticsModule {}
