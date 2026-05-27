import { Module } from "@nestjs/common";
import { TimelineService } from "./timeline.service";
import { TimelineController } from "./timeline.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [TimelineController],
  providers: [TimelineService],
  exports: [TimelineService]
})
export class TimelineModule {}
