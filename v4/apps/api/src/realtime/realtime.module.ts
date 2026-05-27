import { Module } from "@nestjs/common";
import { RealtimeGateway } from "./realtime.gateway";
import { MetricsScheduler } from "./metrics.scheduler";
import { Srv1Module } from "../srv1/srv1.module";

@Module({
  imports: [Srv1Module],
  providers: [RealtimeGateway, MetricsScheduler],
  exports: [RealtimeGateway]
})
export class RealtimeModule {}
