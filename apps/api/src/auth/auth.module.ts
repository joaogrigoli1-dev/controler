import { Module, forwardRef } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { WhatsappService } from "./whatsapp.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { OtpReauthGuard } from "./otp-reauth.guard";
import { RolesGuard } from "./roles.guard";
import { AlertsModule } from "../alerts/alerts.module";

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET || "dev-secret-change-me-min-32-chars-please",
      signOptions: { expiresIn: process.env.JWT_ACCESS_TTL || "15m" }
    }),
    // M-05: alerta de login concorrente. forwardRef quebra o ciclo Auth↔Alerts.
    forwardRef(() => AlertsModule)
  ],
  controllers: [AuthController],
  providers: [AuthService, WhatsappService, JwtAuthGuard, OtpReauthGuard, RolesGuard],
  exports: [AuthService, WhatsappService, JwtAuthGuard, OtpReauthGuard, RolesGuard, JwtModule]
})
export class AuthModule {}
