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
  /** Alvo do SRV1 resolvido de env→SSM (cacheado). Fonte da verdade: SSM /shared/srv1/*. */
  private srv1Target: { host: string; port: number; user: string; keyPath?: string } | null = null;
  private srv1TargetPromise: Promise<{ host: string; port: number; user: string; keyPath?: string }> | null = null;

  constructor(private readonly ssm: SsmService) {}

  async connect(host: string, user = "root", port = 22, keyPath?: string): Promise<NodeSSH> {
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
      const resolvedKeyPath = keyPath || process.env.SRV1_SSH_KEY_PATH || `/root/.ssh/id_ed25519`;
      try {
        await ssh.connect({
          host, username: user, port, privateKeyPath: resolvedKeyPath, readyTimeout: 10_000,
          keepaliveInterval: 30_000, keepaliveCountMax: 3
        });
      } catch (err: any) {
        const pass = await this.ssm.get("/shared/srv1/password");
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

  /** Promise.race com timeout REAL — node-ssh não cancela o canal sozinho. */
  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`SSH timeout ${ms}ms: ${label}`)), ms);
    });
    return Promise.race([
      p.finally(() => clearTimeout(timer)),
      timeout
    ]) as Promise<T>;
  }

  async exec(host: string, command: string, opts?: { user?: string; port?: number; timeoutMs?: number; keyPath?: string }) {
    const user = opts?.user;
    const port = opts?.port;
    const timeoutMs = opts?.timeoutMs ?? 15_000;
    const key = `${user || "root"}@${host}:${port || 22}`;
    try {
      const ssh = await this.connect(host, user, port, opts?.keyPath);
      // FIX: o timeoutMs era ignorado — execCommand podia ficar preso p/ sempre
      // quando o host saturava, segurando o canal SSH e empilhando comandos.
      const result = await this.withTimeout(
        ssh.execCommand(command, { execOptions: { env: { LANG: "C" } as any } }),
        timeoutMs,
        command.slice(0, 60)
      );
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code ?? -1 };
    } catch (err: any) {
      // Conexão morta OU comando estourou timeout: descarta a conexão (fecha o
      // canal preso) para a próxima tentativa reconectar limpa.
      try { this.connections.get(key)?.dispose(); } catch { /* ignore */ }
      this.connections.delete(key);
      throw err;
    }
  }

  /**
   * Resolve o alvo SSH do SRV1. Precedência: env → SSM (/shared/srv1/*) → default.
   * Cacheado após a 1ª resolução. Fonte da verdade da PORTA é o SSM (real: 47391),
   * não o hardcode 22 — corrige o Gap #1 da Fase 0 (coleta quebraria ao fechar a 22).
   */
  private async resolveSrv1Target(): Promise<{ host: string; port: number; user: string; keyPath?: string }> {
    if (this.srv1Target) return this.srv1Target;
    if (this.srv1TargetPromise) return this.srv1TargetPromise;
    this.srv1TargetPromise = (async () => {
      const host =
        process.env.SRV1_SSH_HOST || (await this.ssm.get("/shared/srv1/host")) || "62.72.63.18";
      const portStr =
        process.env.SRV1_SSH_PORT || (await this.ssm.get("/shared/srv1/port")) || "22";
      const port = parseInt(portStr, 10) || 22;
      const user =
        process.env.SRV1_SSH_USER || (await this.ssm.get("/shared/srv1/username")) || "root";
      const keyPath =
        process.env.SRV1_SSH_KEY_PATH || (await this.ssm.get("/shared/srv1/private_key_path")) || undefined;
      const target = { host, port, user, keyPath };
      this.srv1Target = target;
      this.log.log(`SRV1 SSH target resolved ${user}@${host}:${port}`);
      return target;
    })();
    try {
      return await this.srv1TargetPromise;
    } finally {
      this.srv1TargetPromise = null;
    }
  }

  async srv1(command: string, timeoutMs = 15_000) {
    const t = await this.resolveSrv1Target();
    return this.exec(t.host, command, { user: t.user, port: t.port, keyPath: t.keyPath, timeoutMs });
  }

  async onModuleDestroy() {
    for (const c of this.connections.values()) {
      try { c.dispose(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}
