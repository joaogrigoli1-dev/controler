import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { WhatsappService } from "./whatsapp.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { OtpReauthGuard } from "./otp-reauth.guard";

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET || "dev-secret-change-me-min-32-chars-please",
      signOptions: { expiresIn: process.env.JWT_ACCESS_TTL || "15m" }
    })
  ],
  controllers: [AuthController],
  providers: [AuthService, WhatsappService, JwtAuthGuard, OtpReauthGuard],
  exports: [AuthService, WhatsappService, JwtAuthGuard, OtpReauthGuard, JwtModule]
})
export class AuthModule {}
