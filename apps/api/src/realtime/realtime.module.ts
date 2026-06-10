import { Module } from "@nestjs/common";
import { RealtimeGateway } from "./realtime.gateway";
import { MetricsScheduler } from "./metrics.scheduler";
import { Srv1Module } from "../srv1/srv1.module";
import { TimelineModule } from "../timeline/timeline.module";
import { AlertsModule } from "../alerts/alerts.module";
import { HestiaModule } from "../hestia/hestia.module";
import { ApisModule } from "../apis/apis.module";
import { CoolifyModule } from "../coolify/coolify.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [Srv1Module, TimelineModule, AlertsModule, HestiaModule, ApisModule, CoolifyModule, AuthModule],
  providers: [RealtimeGateway, MetricsScheduler],
  exports: [RealtimeGateway]
})
export class RealtimeModule {}
