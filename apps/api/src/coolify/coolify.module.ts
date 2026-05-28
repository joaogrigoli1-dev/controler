import { Module } from "@nestjs/common";
import { CoolifyService } from "./coolify.service";
import { CoolifyController } from "./coolify.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [CoolifyController],
  providers: [CoolifyService],
  exports: [CoolifyService]
})
export class CoolifyModule {}
