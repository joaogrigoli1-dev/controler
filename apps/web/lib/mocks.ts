/**
 * mocks.ts — geradores de mock para endpoints da FASE 3 ainda não implementados.
 *
 * O lib/noc.ts usa estes geradores APENAS quando o endpoint real retorna 404
 * (coletor pendente). Todo dado mock chega ao UI com source:"mock" e é
 * rotulado visualmente (DataBadge) — nunca fingimos dado real (regra STALE
 * da Fase 1: "nunca fingir verde").
 *
 * Valores plausíveis para o SRV1 saudável (Fase 0: CPU ~7%, RAM ~23%,
 * disco ~18%, load 0.64, 8 vCPU / 32 GB / 400 GB).
 */
import type {
  HostSaturation,
  HostDiskIo,
  HostNetwork,
  Reliability,
  HealthOverview,
  StateEvent,
  ContainerPoint
} from "./schemas";

/** Onda determinística (estável dentro do mesmo minuto) — sem Math.random p/ evitar flicker no re-render. */
function wave(seed: number, i: number, base: number, amp: number): number {
  const v = base + amp * Math.sin((i + seed) / 3.1) + amp * 0.35 * Math.sin((i * 7 + seed) / 11.3);
  return Math.max(0, Math.round(v * 100) / 100);
}

function nowBucket(): number {
  return Math.floor(Date.now() / 60_000);
}

export function mockSaturation(): HostSaturation {
  const t = nowBucket();
  return {
    ts: new Date().toISOString(),
    psi: {
      cpu: { some: { avg10: wave(1, t, 2.5, 1.5), avg60: wave(2, t, 2.0, 1.0), avg300: 1.8 }, full: null },
      io: {
        some: { avg10: wave(3, t, 4.0, 2.0), avg60: wave(4, t, 3.0, 1.5), avg300: 2.5 },
        full: { avg10: wave(5, t, 1.2, 0.8), avg60: wave(6, t, 0.9, 0.5), avg300: 0.7 }
      },
      memory: {
        some: { avg10: wave(7, t, 0.4, 0.3), avg60: wave(8, t, 0.3, 0.2), avg300: 0.2 },
        full: { avg10: wave(9, t, 0.1, 0.1), avg60: 0.05, avg300: 0.02 }
      }
    },
    swap: { totalMb: 4096, usedMb: wave(10, t, 180, 40), inPagesSec: 0, outPagesSec: 0 },
    nproc: 8,
    loadPerCore: wave(11, t, 0.09, 0.04)
  };
}

export function mockDiskIo(): HostDiskIo {
  const t = nowBucket();
  return {
    ts: new Date().toISOString(),
    devices: [
      {
        device: "sda",
        utilPercent: wave(20, t, 9, 5),
        readAwaitMs: wave(21, t, 1.2, 0.6),
        writeAwaitMs: wave(22, t, 3.5, 1.5),
        readIops: wave(23, t, 35, 20),
        writeIops: wave(24, t, 85, 40),
        readKbps: wave(25, t, 900, 500),
        writeKbps: wave(26, t, 2400, 1200),
        avgQueueSize: wave(27, t, 0.15, 0.1)
      }
    ]
  };
}

export function mockNetwork(): HostNetwork {
  const t = nowBucket();
  return {
    ts: new Date().toISOString(),
    ifaces: [
      {
        iface: "eth0",
        rxKbps: wave(30, t, 1800, 900),
        txKbps: wave(31, t, 1200, 600),
        rxErrors: 0,
        txErrors: 0,
        rxDrops: 0,
        txDrops: 0
      },
      { iface: "docker0", rxKbps: wave(32, t, 600, 300), txKbps: wave(33, t, 700, 350), rxErrors: 0, txErrors: 0 }
    ],
    tcpRetransPercent: wave(34, t, 0.12, 0.08)
  };
}

/** Série horária p/ drill de container quando /analytics/containers/:name/history vier vazio/404. */
export function mockContainerSeries(name: string, hours = 24): ContainerPoint[] {
  const seed = Array.from(name).reduce((a, c) => a + c.charCodeAt(0), 0) % 50;
  const points: ContainerPoint[] = [];
  const now = Date.now();
  const step = 5 * 60_000; // 5 min
  const n = Math.floor((hours * 3_600_000) / step);
  for (let i = 0; i < n; i++) {
    const ts = new Date(now - (n - i) * step);
    points.push({
      createdAt: ts.toISOString(),
      ts: ts.toISOString(),
      cpuPercent: wave(seed, i, 6, 4),
      memUsedMb: wave(seed + 1, i, 220 + seed * 8, 30),
      memMb: wave(seed + 1, i, 220 + seed * 8, 30),
      memPercent: wave(seed + 2, i, 12, 5),
      netRxKbps: wave(seed + 3, i, 140, 90),
      netTxKbps: wave(seed + 4, i, 90, 60),
      blkioReadKbps: wave(seed + 5, i, 40, 30),
      blkioWriteKbps: wave(seed + 6, i, 120, 80),
      restartCount: 0,
      health: "healthy"
    });
  }
  return points;
}

export function mockStateEvents(name: string): StateEvent[] {
  const base = Date.now() - 6 * 86_400_000;
  return [
    { ts: new Date(base).toISOString(), fromState: null, toState: "running", exitCode: null, oomKilled: false, reason: "start" },
    {
      ts: new Date(base + 2 * 86_400_000).toISOString(),
      fromState: "running",
      toState: "restarting",
      exitCode: 137,
      oomKilled: false,
      reason: `deploy ${name}`
    },
    {
      ts: new Date(base + 2 * 86_400_000 + 12_000).toISOString(),
      fromState: "restarting",
      toState: "running",
      exitCode: null,
      oomKilled: false,
      reason: "healthy"
    }
  ];
}

export function mockReliability(days = 30): Reliability {
  const daily = [];
  const t = nowBucket();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    daily.push({
      date: d.toISOString().slice(0, 10),
      uptimePct: Math.min(100, wave(40, i, 99.7, 0.4)),
      incidents: i === 12 ? 2 : i === 4 ? 1 : 0
    });
  }
  return {
    windowDays: days,
    availabilityPct: 99.62,
    coveragePct: 97.4,
    mttrMinutes: 18,
    timeToDetectMinutes: 2.5,
    mtbfHours: null, // n<5 incidentes → não exibir (regra @validacao)
    incidentCount: 3,
    deploySuccessRatePct: 92,
    deploysTotal: 25,
    dailyAvailability: daily,
    byTarget: [
      { targetType: "container", targetKey: "controler-api", uptimePct: 99.9, incidents: 0, downtimeSec: 120 },
      { targetType: "container", targetKey: "myclinicsoft", uptimePct: 99.4, incidents: 1, downtimeSec: 1500 },
      { targetType: "site", targetKey: "noc.controler.net.br", uptimePct: 99.98, incidents: 0, downtimeSec: 30 }
    ]
  };
}

export function mockHealthOverview(): HealthOverview {
  const t = nowBucket();
  const spark = (s: number, base: number, amp: number) => Array.from({ length: 24 }, (_, i) => wave(s, t - 24 + i, base, amp));
  return {
    score: 92,
    rag: "ok",
    signals: {
      latency: { value: 210, unit: "ms p95", rag: "ok", label: "Latência", spark: spark(50, 220, 60) },
      traffic: { value: 46, unit: "req/s", rag: "ok", label: "Tráfego", spark: spark(51, 45, 18) },
      errors: { value: 0.4, unit: "% 5xx", rag: "ok", label: "Erros", spark: spark(52, 0.5, 0.4) },
      saturation: { value: 4.2, unit: "% PSI", rag: "ok", label: "Saturação", spark: spark(53, 4, 2) }
    },
    mostImportant: {
      title: "4 apps Coolify exited:unhealthy",
      detail: "passaro-professor, libertakidz-backend, manalista, apptecph-web — parados desde a Fase 0.",
      href: "/coolify",
      severity: "warning"
    }
  };
}
