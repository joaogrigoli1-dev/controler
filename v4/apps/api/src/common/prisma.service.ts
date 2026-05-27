import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Prisma");

  async onModuleInit() {
    await this.$connect();
    this.log.log("Prisma connected");
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
