import { Module } from "@nestjs/common";
import { DeploysController } from "./deploys.controller";
import { DeploysService } from "./deploys.service";
import { DeploysScheduler } from "./deploys.scheduler";
import { AuthModule } from "../auth/auth.module";
import { CoolifyModule } from "../coolify/coolify.module";
import { AlertsModule } from "../alerts/alerts.module";
import { TimelineModule } from "../timeline/timeline.module";

@Module({
  // FASE 3: scheduler de captura de deploys vive aqui (removido do realtime/metrics.scheduler)
  imports: [AuthModule, CoolifyModule, AlertsModule, TimelineModule],
  controllers: [DeploysController],
  providers: [DeploysService, DeploysScheduler]
})
export class DeploysModule {}
