import { Injectable, Logger } from "@nestjs/common";
import axios, { AxiosInstance } from "axios";
import { SsmService } from "./ssm.service";

const BASE = process.env.HOSTINGER_API_BASE_URL || "https://developers.hostinger.com/api/vps/v1";
const SRV1_VPS_ID = parseInt(process.env.SRV1_VPS_ID || "1379597", 10);
const FISIOMT_VPS_ID = parseInt(process.env.FISIOMT_VPS_ID || "1514729", 10);

export interface VpsMetricSeries {
  unit: string;
  usage: Record<string, number>; // timestamp → value
}

export interface VpsMetrics {
  cpu_usage: VpsMetricSeries;
  ram_usage: VpsMetricSeries;
  disk_space: VpsMetricSeries;
  outgoing_traffic: VpsMetricSeries;
  incoming_traffic: VpsMetricSeries;
  uptime: VpsMetricSeries;
}

@Injectable()
export class HostingerService {
  private readonly log = new Logger("Hostinger");
  private client: AxiosInstance | null = null;

  constructor(private readonly ssm: SsmService) {}

  private async getClient(): Promise<AxiosInstance> {
    if (this.client) return this.client;
    const token =
      process.env.HOSTINGER_API_TOKEN ||
      (await this.ssm.get("/controler/hostinger_api_token")) ||
      (await this.ssm.get("/myclinicsoft/hostinger_api_token"));
    if (!token) throw new Error("Hostinger token não configurado");
    this.client = axios.create({
      baseURL: BASE,
      timeout: 15_000,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    return this.client;
  }

  async listVps() {
    const c = await this.getClient();
    const { data } = await c.get("/virtual-machines");
    return data;
  }

  async getVps(vmId = SRV1_VPS_ID) {
    const c = await this.getClient();
    const { data } = await c.get(`/virtual-machines/${vmId}`);
    return data;
  }

  async getMetrics(vmId = SRV1_VPS_ID, hours = 1): Promise<VpsMetrics> {
    const c = await this.getClient();
    const now = Math.floor(Date.now() / 1000);
    const from = now - hours * 3600;
    const { data } = await c.get(`/virtual-machines/${vmId}/metrics`, {
      params: { date_from: from, date_to: now }
    });
    return data;
  }

  async getFirewalls() {
    const c = await this.getClient();
    const { data } = await c.get("/firewall");
    return data;
  }

  async getFirewallRules(groupId: number) {
    const c = await this.getClient();
    const { data } = await c.get(`/firewall/${groupId}`);
    return data;
  }

  static SRV1 = SRV1_VPS_ID;
  static FISIOMT = FISIOMT_VPS_ID;
}
