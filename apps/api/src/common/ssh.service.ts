/**
 * SshService — wrapper sobre node-ssh com pool real de conexões.
 *
 * BUG anterior: `existing.isConnected?.()` não existe em node-ssh — sempre criava
 * conexão nova, e SRV1 sshd começava a recusar com "Channel open failure" após
 * algumas dezenas de conexões abertas em paralelo.
 *
 * Agora: 1 conexão por host reusada para sempre. Reset on error.
 */

import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { NodeSSH } from "node-ssh";
import { SsmService } from "./ssm.service";

@Injectable()
export class SshService implements OnModuleDestroy {
  private readonly log = new Logger("SSH");
  private connections = new Map<string, NodeSSH>();
  private connectPromises = new Map<string, Promise<NodeSSH>>();

  constructor(private readonly ssm: SsmService) {}

  async connect(host: string, user = "root", port = 22): Promise<NodeSSH> {
    const key = `${user}@${host}:${port}`;

    const existing = this.connections.get(key);
    // node-ssh expõe .connection (internal client). Se .connection existe e tem _sock writable, está vivo.
    if (existing && (existing as any).connection && !(existing as any).connection.destroyed) {
      return existing;
    }

    // Coalesce concurrent connect calls
    const pending = this.connectPromises.get(key);
    if (pending) return pending;

    const promise = (async () => {
      const ssh = new NodeSSH();
      const keyPath = process.env.SRV1_SSH_KEY_PATH || `/root/.ssh/id_ed25519`;
      try {
        await ssh.connect({
          host, username: user, port, privateKeyPath: keyPath, readyTimeout: 10_000,
          keepaliveInterval: 30_000, keepaliveCountMax: 3
        });
      } catch (err: any) {
        const pass = await this.ssm.get("/controler/srv1_ssh_password");
        if (!pass) throw new Error(`SSH ${host}: chave falhou e sem senha em SSM`);
        await ssh.connect({
          host, username: user, port, password: pass, readyTimeout: 10_000,
          keepaliveInterval: 30_000, keepaliveCountMax: 3
        });
      }
      this.connections.set(key, ssh);
      this.log.log(`SSH connected ${key}`);

      // Auto-cleanup on disconnect
      const client = (ssh as any).connection;
      if (client) {
        client.once("close", () => {
          this.log.warn(`SSH connection closed ${key}, will reconnect on next use`);
          this.connections.delete(key);
        });
        client.once("error", (e: any) => {
          this.log.warn(`SSH error ${key}: ${e?.message}`);
          this.connections.delete(key);
        });
      }
      return ssh;
    })();

    this.connectPromises.set(key, promise);
    try {
      const result = await promise;
      return result;
    } finally {
      this.connectPromises.delete(key);
    }
  }

  async exec(host: string, command: string, opts?: { user?: string; port?: number; timeoutMs?: number }) {
    const user = opts?.user;
    const port = opts?.port;
    try {
      const ssh = await this.connect(host, user, port);
      const result = await ssh.execCommand(command, { execOptions: { env: { LANG: "C" } as any } });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code ?? -1 };
    } catch (err: any) {
      // Se a conexão estiver morta, tira do cache para próxima tentativa reconectar
      const key = `${user || "root"}@${host}:${port || 22}`;
      this.connections.delete(key);
      throw err;
    }
  }

  async srv1(command: string, timeoutMs = 15_000) {
    return this.exec(process.env.SRV1_SSH_HOST || "62.72.63.18", command, { timeoutMs });
  }

  async onModuleDestroy() {
    for (const c of this.connections.values()) {
      try { c.dispose(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}
