/**
 * SshService — wrapper sobre node-ssh para SRV1.
 * Em prod usa chave SSH montada via Docker volume (/root/.ssh).
 * Em dev usa ~/.ssh/id_ed25519 do usuário.
 */

import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { NodeSSH } from "node-ssh";
import { SsmService } from "./ssm.service";

@Injectable()
export class SshService implements OnModuleDestroy {
  private readonly log = new Logger("SSH");
  private connections = new Map<string, NodeSSH>();

  constructor(private readonly ssm: SsmService) {}

  async connect(host: string, user = "root", port = 22): Promise<NodeSSH> {
    const key = `${user}@${host}:${port}`;
    const existing = this.connections.get(key);
    if (existing && (existing as any).isConnected?.()) return existing;

    const ssh = new NodeSSH();
    const keyPath = process.env.SRV1_SSH_KEY_PATH || `/root/.ssh/id_ed25519`;
    try {
      await ssh.connect({ host, username: user, port, privateKeyPath: keyPath, readyTimeout: 10_000 });
    } catch (err: any) {
      // Fallback: tentar senha via SSM
      const pass = await this.ssm.get("/controler/srv1_ssh_password");
      if (!pass) throw new Error(`SSH ${host}: chave falhou e sem senha em SSM`);
      await ssh.connect({ host, username: user, port, password: pass, readyTimeout: 10_000 });
    }
    this.connections.set(key, ssh);
    this.log.log(`SSH connected ${key}`);
    return ssh;
  }

  async exec(host: string, command: string, opts?: { user?: string; port?: number; timeoutMs?: number }) {
    const ssh = await this.connect(host, opts?.user, opts?.port);
    const result = await ssh.execCommand(command, { execOptions: { env: { LANG: "C" } as any } });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code ?? -1 };
  }

  /** Convenience: SRV1 host */
  async srv1(command: string, timeoutMs = 15_000) {
    return this.exec(process.env.SRV1_SSH_HOST || "62.72.63.18", command, { timeoutMs });
  }

  async onModuleDestroy() {
    for (const c of this.connections.values()) c.dispose();
    this.connections.clear();
  }
}
