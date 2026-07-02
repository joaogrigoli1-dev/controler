import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Srv1Service } from "./srv1.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OtpReauthGuard } from "../auth/otp-reauth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/roles.decorator";
import { SshService } from "../common/ssh.service";

@UseGuards(JwtAuthGuard)
@Controller("srv1")
export class Srv1Controller {
  constructor(private readonly srv1: Srv1Service, private readonly ssh: SshService) {}

  @Get("host")
  host() {
    return this.srv1.getHostMetrics();
  }

  @Get("containers")
  containers() {
    return this.srv1.getContainers();
  }

  @Get("services")
  services() {
    return this.srv1.getServices();
  }

  @Get("processes")
  processes(@Query("by") by: "cpu" | "mem" = "cpu", @Query("limit") limit?: string) {
    return this.srv1.getTopProcesses(by, limit ? parseInt(limit, 10) : 10);
  }

  @Get("ports")
  ports() {
    return this.srv1.getPorts();
  }

  @Get("journal/:unit")
  journal(@Param("unit") unit: string, @Query("lines") lines?: string) {
    return this.srv1.tailJournal(unit, lines ? parseInt(lines, 10) : 100);
  }

  // Restart serviço — exige papel admin + re-auth OTP (ação destrutiva)
  @Roles("admin")
  @UseGuards(RolesGuard, OtpReauthGuard)
  @Post("services/:unit/restart")
  async restartService(@Param("unit") unit: string) {
    if (!/^[a-zA-Z0-9@._-]+\.service$/.test(unit)) {
      return { ok: false, error: "unit inválida" };
    }
    const result = await this.ssh.srv1(`systemctl restart ${unit}`, 10_000);
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
  }

  @Roles("admin")
  @UseGuards(RolesGuard, OtpReauthGuard)
  @Post("containers/:name/:action")
  async containerAction(@Param("name") name: string, @Param("action") action: string) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return { ok: false, error: "name inválido" };
    if (!["restart", "stop", "start"].includes(action)) return { ok: false, error: "action inválida" };
    const result = await this.ssh.srv1(`docker ${action} ${name}`, 30_000);
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
  }
}
