import { Module } from "@nestjs/common";
import { HestiaController } from "./hestia.controller";
import { HestiaService } from "./hestia.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [HestiaController],
  providers: [HestiaService],
  exports: [HestiaService]
})
export class HestiaModule {}
