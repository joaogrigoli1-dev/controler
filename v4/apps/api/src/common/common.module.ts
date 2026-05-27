import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { SsmService } from "./ssm.service";
import { RedisService } from "./redis.service";
import { HostingerService } from "./hostinger.service";
import { SshService } from "./ssh.service";

@Global()
@Module({
  providers: [PrismaService, SsmService, RedisService, HostingerService, SshService],
  exports: [PrismaService, SsmService, RedisService, HostingerService, SshService]
})
export class CommonModule {}
