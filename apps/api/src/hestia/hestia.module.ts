import { Module } from "@nestjs/common";
import { HestiaController } from "./hestia.controller";
import { HestiaService } from "./hestia.service";
import { SslScheduler } from "./ssl.scheduler";
import { AuthModule } from "../auth/auth.module";
import { AlertsModule } from "../alerts/alerts.module";

@Module({
  // FASE 3: SslScheduler (probe TLS a cada 6h) precisa do AlertsService
  imports: [AuthModule, AlertsModule],
  controllers: [HestiaController],
  providers: [HestiaService, SslScheduler],
  exports: [HestiaService]
})
export class HestiaModule {}
