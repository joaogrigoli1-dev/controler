import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CoolifyService } from "./coolify.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OtpReauthGuard } from "../auth/otp-reauth.guard";

@UseGuards(JwtAuthGuard)
@Controller("coolify")
export class CoolifyController {
  constructor(private readonly coolify: CoolifyService) {}

  @Get("apps")
  apps() {
    return this.coolify.listApplications();
  }

  @Get("apps/:uuid")
  app(@Param("uuid") uuid: string) {
    return this.coolify.getApplication(uuid);
  }

  @Get("apps/:uuid/envs")
  envs(@Param("uuid") uuid: string) {
    return this.coolify.getEnvs(uuid);
  }

  @Get("apps/:uuid/logs")
  logs(@Param("uuid") uuid: string, @Query("lines") lines?: string) {
    return this.coolify.getLogs(uuid, lines ? parseInt(lines, 10) : 200);
  }

  @Get("apps/:uuid/deployments")
  deployments(@Param("uuid") uuid: string) {
    return this.coolify.listDeployments(uuid);
  }

  @Get("servers")
  servers() {
    return this.coolify.listServers();
  }

  @UseGuards(OtpReauthGuard)
  @Post("apps/:uuid/deploy")
  deploy(@Param("uuid") uuid: string, @Query("force") force?: string) {
    return this.coolify.deploy(uuid, force === "true");
  }

  @UseGuards(OtpReauthGuard)
  @Post("apps/:uuid/restart")
  restart(@Param("uuid") uuid: string) {
    return this.coolify.restart(uuid);
  }

  @UseGuards(OtpReauthGuard)
  @Post("apps/:uuid/stop")
  stop(@Param("uuid") uuid: string) {
    return this.coolify.stop(uuid);
  }

  @UseGuards(OtpReauthGuard)
  @Post("apps/:uuid/start")
  start(@Param("uuid") uuid: string) {
    return this.coolify.start(uuid);
  }
}
