import { Module } from "@nestjs/common";
import { ApisController } from "./apis.controller";
import { ApisService } from "./apis.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [ApisController],
  providers: [ApisService],
  exports: [ApisService]
})
export class ApisModule {}
