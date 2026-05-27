import { Module } from "@nestjs/common";
import { VaultController } from "./vault.controller";
import { VaultService } from "./vault.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [VaultController],
  providers: [VaultService]
})
export class VaultModule {}
