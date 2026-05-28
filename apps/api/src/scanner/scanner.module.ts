import { Module } from "@nestjs/common";
import { ScannerController } from "./scanner.controller";
import { ScannerService } from "./scanner.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [ScannerController],
  providers: [ScannerService]
})
export class ScannerModule {}
