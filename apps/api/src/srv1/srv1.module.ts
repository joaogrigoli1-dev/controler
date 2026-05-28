import { Module } from "@nestjs/common";
import { Srv1Controller } from "./srv1.controller";
import { Srv1Service } from "./srv1.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [Srv1Controller],
  providers: [Srv1Service],
  exports: [Srv1Service]
})
export class Srv1Module {}
