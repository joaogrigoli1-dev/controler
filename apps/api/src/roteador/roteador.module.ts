import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RoteadorController } from "./roteador.controller";
import { RoteadorDashboardService } from "./roteador-dashboard.service";
import { SincIngestGuard } from "../sinc/sinc-ingest.guard";

@Module({ imports: [AuthModule], controllers: [RoteadorController], providers: [RoteadorDashboardService, SincIngestGuard] })
export class RoteadorModule {}
