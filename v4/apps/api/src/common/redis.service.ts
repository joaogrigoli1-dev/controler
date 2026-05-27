import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Redis");
  public readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: 3,
      lazyConnect: true
    });
  }

  async onModuleInit() {
    try {
      await this.client.connect();
      this.log.log("Redis connected");
    } catch (err: any) {
      this.log.warn(`Redis connect failed: ${err?.message}`);
    }
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  /** Cache helper with TTL */
  async cached<T>(key: string, ttlSec: number, factory: () => Promise<T>): Promise<T> {
    try {
      const cached = await this.client.get(key);
      if (cached) return JSON.parse(cached) as T;
      const value = await factory();
      await this.client.setex(key, ttlSec, JSON.stringify(value));
      return value;
    } catch {
      return factory();
    }
  }

  async invalidate(prefix: string) {
    try {
      const keys = await this.client.keys(`${prefix}*`);
      if (keys.length) await this.client.del(...keys);
    } catch {}
  }
}
