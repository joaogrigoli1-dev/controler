import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import axios, { AxiosInstance } from "axios";
import { SsmService } from "../common/ssm.service";
import { RedisService } from "../common/redis.service";

@Injectable()
export class CoolifyService {
  private readonly log = new Logger("Coolify");
  private client: AxiosInstance | null = null;

  constructor(private readonly ssm: SsmService, private readonly redis: RedisService) {}

  /** B-06: valida o formato do uuid antes de interpolar em URL/params (evita SSRF/path-injection). */
  private assertUuid(uuid: string): string {
    if (!uuid || !/^[a-z0-9]{16,40}$/i.test(uuid)) {
      throw new BadRequestException("uuid inválido");
    }
    return uuid;
  }

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
    this.assertUuid(uuid);
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

  /**
   * FASE 3 (Gap #6): a rota antiga `GET /deployments?uuid=` retornava 404 sempre.
   * Rota correta da API do Coolify: `GET /api/v1/deployments/applications/{uuid}`.
   * 404 → [] (app sem histórico de deploy). Cada item é normalizado com os campos
   * canônicos do contrato (deployment_uuid, status, commit, commit_message,
   * created_at, started_at, finished_at, durationSec) mantendo os originais.
   */
  async listDeployments(uuid: string) {
    this.assertUuid(uuid);
    const c = await this.getClient();
    const res = await c.get(`/deployments/applications/${uuid}`, { validateStatus: () => true });
    if (res.status === 404) return [];
    if (res.status >= 400) {
      this.log.warn(`listDeployments(${uuid}) → HTTP ${res.status}`);
      return [];
    }
    // A API pode devolver array direto ou envelope { deployments: [...] } / { data: [...] }
    const raw = Array.isArray(res.data) ? res.data : res.data?.deployments ?? res.data?.data ?? [];
    if (!Array.isArray(raw)) return [];
    return raw.map((d: any) => {
      const started = d.started_at ?? d.created_at ?? null;
      const finished = d.finished_at ?? null;
      let durationSec: number | null = null;
      if (started && finished) {
        const delta = (new Date(finished).getTime() - new Date(started).getTime()) / 1000;
        durationSec = Number.isFinite(delta) && delta >= 0 ? Math.round(delta) : null;
      }
      return {
        ...d,
        deployment_uuid: d.deployment_uuid ?? d.uuid ?? null,
        status: d.status ?? null,
        commit: d.commit ?? d.git_commit_sha ?? null,
        commit_message: d.commit_message ?? null,
        created_at: d.created_at ?? null,
        started_at: started,
        finished_at: finished,
        durationSec
      };
    });
  }

  async getEnvs(uuid: string) {
    this.assertUuid(uuid);
    const c = await this.getClient();
    const { data } = await c.get(`/applications/${uuid}/envs`);
    return data;
  }

  async deploy(uuid: string, force = false) {
    this.assertUuid(uuid);
    const c = await this.getClient();
    const { data } = await c.get(`/deploy`, { params: { uuid, force } });
    await this.redis.invalidate("coolify:");
    return data;
  }

  async restart(uuid: string) {
    this.assertUuid(uuid);
    const c = await this.getClient();
    const { data } = await c.post(`/applications/${uuid}/restart`);
    return data;
  }

  async stop(uuid: string) {
    this.assertUuid(uuid);
    const c = await this.getClient();
    const { data } = await c.post(`/applications/${uuid}/stop`);
    return data;
  }

  async start(uuid: string) {
    this.assertUuid(uuid);
    const c = await this.getClient();
    const { data } = await c.post(`/applications/${uuid}/start`);
    return data;
  }

  async getLogs(uuid: string, lines = 200) {
    this.assertUuid(uuid);
    const c = await this.getClient();
    try {
      const { data } = await c.get(`/applications/${uuid}/logs`, { params: { lines } });
      return data;
    } catch {
      return { logs: "" };
    }
  }
}
