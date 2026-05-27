/**
 * SsmService — wrapper sobre AWS SSM Parameter Store.
 * Em dev usa AWS_PROFILE=cowork-admin via ~/.aws/credentials.
 * Em prod usa IAM role do container.
 */

import { Injectable, Logger } from "@nestjs/common";
import { SSMClient, GetParameterCommand, GetParametersByPathCommand, Parameter } from "@aws-sdk/client-ssm";

interface CachedValue {
  value: string;
  expiresAt: number;
}

@Injectable()
export class SsmService {
  private readonly log = new Logger("SSM");
  private readonly client: SSMClient;
  private readonly cache = new Map<string, CachedValue>();
  private readonly CACHE_TTL_MS = 60_000;

  constructor() {
    this.client = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });
  }

  /**
   * Busca um parâmetro decifrado. Cache de 60s em memória.
   * Retorna null se não encontrar (não dispara erro).
   */
  async get(name: string, useCache = true): Promise<string | null> {
    if (useCache) {
      const c = this.cache.get(name);
      if (c && c.expiresAt > Date.now()) return c.value;
    }
    try {
      const res = await this.client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      const value = res.Parameter?.Value ?? null;
      if (value !== null) {
        this.cache.set(name, { value, expiresAt: Date.now() + this.CACHE_TTL_MS });
      }
      return value;
    } catch (err: any) {
      if (err?.name === "ParameterNotFound") return null;
      this.log.warn(`SSM get(${name}) failed: ${err?.message}`);
      return null;
    }
  }

  /**
   * Lista parâmetros sob um path (recursivo).
   * Valores são mascarados a menos que `revealValues=true`.
   */
  async listByPath(path: string, revealValues = false): Promise<Parameter[]> {
    const params: Parameter[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.client.send(
        new GetParametersByPathCommand({
          Path: path,
          Recursive: true,
          WithDecryption: revealValues,
          NextToken: nextToken,
          MaxResults: 10
        })
      );
      if (res.Parameters) params.push(...res.Parameters);
      nextToken = res.NextToken;
    } while (nextToken);

    if (!revealValues) {
      params.forEach(p => {
        if (p.Type === "SecureString") p.Value = "•••";
        // String types stay visible
      });
    }
    return params;
  }

  invalidate(name?: string) {
    if (name) this.cache.delete(name);
    else this.cache.clear();
  }
}
