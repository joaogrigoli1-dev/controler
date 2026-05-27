import { Injectable, Logger } from "@nestjs/common";
import axios, { AxiosInstance } from "axios";
import { SsmService } from "../common/ssm.service";
import { RedisService } from "../common/redis.service";

@Injectable()
export class CoolifyService {
  private readonly log = new Logger("Coolify");
  private client: AxiosInstance | null = null;

  constructor(private readonly ssm: SsmService, private readonly redis: RedisService) {}

  private async getClient(): Promise<AxiosInstance> {
    if (this.client) return this.client;
    const baseURL = process.env.COOLIFY_BASE_URL || "https://coolify.controler.net.br";
    const token = process.env.COOLIFY_TOKEN || (await this.ssm.get("/controler/coolify_token"));
    if (!token) throw new Error("Coolify token não configurado em SSM");
    this.client = axios.create({
      baseURL: `${baseURL.replace(/\/$/, "")}/api/v1`,
      timeout: 15_000,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    return this.client;
  }

  async listApplications() {
    return this.redis.cached("coolify:apps", 30, async () => {
      const c = await this.getClient();
      const { data } = await c.get("/applications");
      return data;
    });
  }

  async getApplication(uuid: string) {
    const c = await this.getClient();
    const { data } = await c.get(`/applications/${uuid}`);
    return data;
  }

  async listServers() {
    return this.redis.cached("coolify:servers", 60, async () => {
      const c = await this.getClient();
      const { data } = await c.get("/servers");
      return data;
    });
  }

  async listDeployments(uuid: string) {
    const c = await this.getClient();
    const { data } = await c.get(`/deployments`, { params: { uuid } }).catch(() => ({ data: [] }));
    return data;
  }

  async getEnvs(uuid: string) {
    const c = await this.getClient();
    const { data } = await c.get(`/applications/${uuid}/envs`);
    return data;
  }

  async deploy(uuid: string, force = false) {
    const c = await this.getClient();
    const { data } = await c.get(`/deploy`, { params: { uuid, force } });
    await this.redis.invalidate("coolify:");
    return data;
  }

  async restart(uuid: string) {
    const c = await this.getClient();
    const { data } = await c.post(`/applications/${uuid}/restart`);
    return data;
  }

  async stop(uuid: string) {
    const c = await this.getClient();
    const { data } = await c.post(`/applications/${uuid}/stop`);
    return data;
  }

  async start(uuid: string) {
    const c = await this.getClient();
    const { data } = await c.post(`/applications/${uuid}/start`);
    return data;
  }

  async getLogs(uuid: string, lines = 200) {
    const c = await this.getClient();
    try {
      const { data } = await c.get(`/applications/${uuid}/logs`, { params: { lines } });
      return data;
    } catch {
      return { logs: "" };
    }
  }
}
