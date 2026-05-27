import { Module } from "@nestjs/common";
import { DeploysController } from "./deploys.controller";
import { DeploysService } from "./deploys.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [DeploysController],
  providers: [DeploysService]
})
export class DeploysModule {}
