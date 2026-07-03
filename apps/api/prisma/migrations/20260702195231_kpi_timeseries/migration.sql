-- CreateEnum
CREATE TYPE "Granularity" AS ENUM ('hourly', 'daily');

-- CreateEnum
CREATE TYPE "ContainerHealth" AS ENUM ('healthy', 'unhealthy', 'starting', 'none', 'exited');

-- CreateEnum
CREATE TYPE "UptimeTargetType" AS ENUM ('container', 'site', 'api', 'systemd_unit', 'host');

-- AlterTable
ALTER TABLE "host_metric_snapshots" ADD COLUMN     "psiCpuSomeAvg10" DOUBLE PRECISION,
ADD COLUMN     "psiCpuSomeAvg300" DOUBLE PRECISION,
ADD COLUMN     "psiCpuSomeAvg60" DOUBLE PRECISION,
ADD COLUMN     "psiIoFullAvg10" DOUBLE PRECISION,
ADD COLUMN     "psiIoFullAvg60" DOUBLE PRECISION,
ADD COLUMN     "psiIoSomeAvg10" DOUBLE PRECISION,
ADD COLUMN     "psiIoSomeAvg60" DOUBLE PRECISION,
ADD COLUMN     "psiMemFullAvg10" DOUBLE PRECISION,
ADD COLUMN     "psiMemFullAvg60" DOUBLE PRECISION,
ADD COLUMN     "psiMemSomeAvg10" DOUBLE PRECISION,
ADD COLUMN     "psiMemSomeAvg60" DOUBLE PRECISION,
ADD COLUMN     "swapInPagesSec" DOUBLE PRECISION,
ADD COLUMN     "swapOutPagesSec" DOUBLE PRECISION,
ADD COLUMN     "swapTotalMb" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "deploy_history" ADD COLUMN     "deploymentUuid" TEXT,
ADD COLUMN     "failReason" TEXT,
ADD COLUMN     "imageTag" TEXT,
ADD COLUMN     "isRollback" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "queuedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "containers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "coolifyUuid" TEXT,
    "image" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'app',
    "monitored" BOOLEAN NOT NULL DEFAULT true,
    "currentHealth" "ContainerHealth" NOT NULL DEFAULT 'none',
    "restartCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container_metric_points" (
    "id" BIGSERIAL NOT NULL,
    "containerId" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memUsedMb" DOUBLE PRECISION NOT NULL,
    "memLimitMb" DOUBLE PRECISION,
    "memPercent" DOUBLE PRECISION,
    "netRxKbps" DOUBLE PRECISION,
    "netTxKbps" DOUBLE PRECISION,
    "blkioReadKbps" DOUBLE PRECISION,
    "blkioWriteKbps" DOUBLE PRECISION,
    "pids" INTEGER,
    "restartCount" INTEGER,
    "health" "ContainerHealth" NOT NULL DEFAULT 'none',
    "uptimeSec" INTEGER,

    CONSTRAINT "container_metric_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container_state_events" (
    "id" BIGSERIAL NOT NULL,
    "containerId" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "exitCode" INTEGER,
    "oomKilled" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,

    CONSTRAINT "container_state_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_disk_io_points" (
    "id" BIGSERIAL NOT NULL,
    "device" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "utilPercent" DOUBLE PRECISION NOT NULL,
    "readAwaitMs" DOUBLE PRECISION,
    "writeAwaitMs" DOUBLE PRECISION,
    "readIops" DOUBLE PRECISION,
    "writeIops" DOUBLE PRECISION,
    "readKbps" DOUBLE PRECISION,
    "writeKbps" DOUBLE PRECISION,
    "avgQueueSize" DOUBLE PRECISION,

    CONSTRAINT "host_disk_io_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_process_samples" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rank" INTEGER NOT NULL,
    "pid" INTEGER NOT NULL,
    "command" TEXT NOT NULL,
    "cgroup" TEXT,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memMb" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "host_process_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "systemd_unit_events" (
    "id" BIGSERIAL NOT NULL,
    "unitName" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeState" TEXT NOT NULL,
    "subState" TEXT,
    "fromState" TEXT,
    "nRestarts" INTEGER,
    "message" TEXT,

    CONSTRAINT "systemd_unit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ssl_check_history" (
    "id" BIGSERIAL NOT NULL,
    "domain" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "notAfter" TIMESTAMP(3),
    "daysRemaining" INTEGER,
    "issuer" TEXT,
    "error" TEXT,

    CONSTRAINT "ssl_check_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container_metric_rollups" (
    "id" BIGSERIAL NOT NULL,
    "containerId" INTEGER NOT NULL,
    "granularity" "Granularity" NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "cpuAvg" DOUBLE PRECISION NOT NULL,
    "cpuMax" DOUBLE PRECISION NOT NULL,
    "cpuP95" DOUBLE PRECISION,
    "memAvgMb" DOUBLE PRECISION NOT NULL,
    "memMaxMb" DOUBLE PRECISION NOT NULL,
    "netRxKbpsAvg" DOUBLE PRECISION,
    "netTxKbpsAvg" DOUBLE PRECISION,
    "blkioReadKbpsAvg" DOUBLE PRECISION,
    "blkioWriteKbpsAvg" DOUBLE PRECISION,
    "restartsDelta" INTEGER NOT NULL DEFAULT 0,
    "unhealthySec" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "container_metric_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_metric_rollups" (
    "id" BIGSERIAL NOT NULL,
    "granularity" "Granularity" NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "cpuAvg" DOUBLE PRECISION NOT NULL,
    "cpuMax" DOUBLE PRECISION NOT NULL,
    "loadAvg1mMax" DOUBLE PRECISION,
    "memUsedAvgMb" DOUBLE PRECISION NOT NULL,
    "memUsedMaxMb" DOUBLE PRECISION NOT NULL,
    "swapUsedMaxMb" INTEGER,
    "psiCpuSomeMax" DOUBLE PRECISION,
    "psiIoFullMax" DOUBLE PRECISION,
    "psiMemFullMax" DOUBLE PRECISION,
    "diskUtilMaxPct" DOUBLE PRECISION,
    "diskAwaitMaxMs" DOUBLE PRECISION,

    CONSTRAINT "host_metric_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_rollups" (
    "id" BIGSERIAL NOT NULL,
    "targetType" "UptimeTargetType" NOT NULL,
    "targetKey" TEXT NOT NULL,
    "granularity" "Granularity" NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "checksTotal" INTEGER NOT NULL DEFAULT 0,
    "checksUp" INTEGER NOT NULL DEFAULT 0,
    "downtimeSec" INTEGER NOT NULL DEFAULT 0,
    "incidents" INTEGER NOT NULL DEFAULT 0,
    "uptimePct" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "availability_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "containers_name_key" ON "containers"("name");

-- CreateIndex
CREATE INDEX "containers_coolifyUuid_idx" ON "containers"("coolifyUuid");

-- CreateIndex
CREATE INDEX "container_metric_points_containerId_ts_idx" ON "container_metric_points"("containerId", "ts" DESC);

-- CreateIndex
CREATE INDEX "container_metric_points_ts_idx" ON "container_metric_points"("ts");

-- CreateIndex
CREATE INDEX "container_state_events_containerId_ts_idx" ON "container_state_events"("containerId", "ts" DESC);

-- CreateIndex
CREATE INDEX "container_state_events_ts_idx" ON "container_state_events"("ts");

-- CreateIndex
CREATE INDEX "host_disk_io_points_device_ts_idx" ON "host_disk_io_points"("device", "ts" DESC);

-- CreateIndex
CREATE INDEX "host_disk_io_points_ts_idx" ON "host_disk_io_points"("ts");

-- CreateIndex
CREATE INDEX "host_process_samples_ts_idx" ON "host_process_samples"("ts" DESC);

-- CreateIndex
CREATE INDEX "systemd_unit_events_unitName_ts_idx" ON "systemd_unit_events"("unitName", "ts" DESC);

-- CreateIndex
CREATE INDEX "systemd_unit_events_activeState_ts_idx" ON "systemd_unit_events"("activeState", "ts" DESC);

-- CreateIndex
CREATE INDEX "ssl_check_history_domain_checkedAt_idx" ON "ssl_check_history"("domain", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "container_metric_rollups_granularity_bucket_idx" ON "container_metric_rollups"("granularity", "bucket" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "container_metric_rollups_containerId_granularity_bucket_key" ON "container_metric_rollups"("containerId", "granularity", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "host_metric_rollups_granularity_bucket_key" ON "host_metric_rollups"("granularity", "bucket");

-- CreateIndex
CREATE INDEX "availability_rollups_targetType_granularity_bucket_idx" ON "availability_rollups"("targetType", "granularity", "bucket" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "availability_rollups_targetType_targetKey_granularity_bucke_key" ON "availability_rollups"("targetType", "targetKey", "granularity", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "deploy_history_deploymentUuid_key" ON "deploy_history"("deploymentUuid");

-- CreateIndex
CREATE INDEX "deploy_history_coolifyUuid_startedAt_idx" ON "deploy_history"("coolifyUuid", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "container_metric_points" ADD CONSTRAINT "container_metric_points_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "containers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container_state_events" ADD CONSTRAINT "container_state_events_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "containers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container_metric_rollups" ADD CONSTRAINT "container_metric_rollups_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "containers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Custom: BRIN indexes on ts for append-only time-series tables (purge/rollup scans, ~1000x smaller than btree)
CREATE INDEX "container_metric_points_ts_brin" ON "container_metric_points" USING BRIN ("ts");
CREATE INDEX "host_disk_io_points_ts_brin" ON "host_disk_io_points" USING BRIN ("ts");
CREATE INDEX "host_process_samples_ts_brin" ON "host_process_samples" USING BRIN ("ts");
CREATE INDEX "container_state_events_ts_brin" ON "container_state_events" USING BRIN ("ts");
CREATE INDEX "systemd_unit_events_ts_brin" ON "systemd_unit_events" USING BRIN ("ts");

