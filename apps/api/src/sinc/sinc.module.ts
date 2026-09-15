import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SincController } from "./sinc.controller";
import { SincService } from "./sinc.service";
import { SincIngestGuard } from "./sinc-ingest.guard";

@Module({ imports: [AuthModule], controllers: [SincController], providers: [SincService, SincIngestGuard] })
export class SincModule {}
