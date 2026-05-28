/**
 * Tests para heatmap24h — algoritmo puro, sem DB.
 */

import { describe, it, expect } from "vitest";

interface FakeEvent { createdAt: Date; severity: "info" | "warning" | "critical"; }

function heatmap24h(events: FakeEvent[], now = Date.now()): Record<string, { info: number; warning: number; critical: number }> {
  const TZ_OFFSET_MS = -3 * 3600_000;
  const buckets: Array<{ key: string; info: number; warning: number; critical: number }> = [];
  for (let h = 23; h >= 0; h--) {
    const ts = new Date(now - h * 3600_000 + TZ_OFFSET_MS);
    const hh = ts.getUTCHours();
    buckets.push({ key: `${hh.toString().padStart(2, "0")}h`, info: 0, warning: 0, critical: 0 });
  }
  events.forEach(e => {
    const eventTime = new Date(e.createdAt).getTime();
    const hoursAgo = Math.floor((now - eventTime) / 3600_000);
    if (hoursAgo < 0 || hoursAgo > 23) return;
    const idx = 23 - hoursAgo;
    if (buckets[idx]) buckets[idx][e.severity]++;
  });
  return buckets.reduce((acc, b) => {
    acc[b.key] = { info: b.info, warning: b.warning, critical: b.critical };
    return acc;
  }, {} as any);
}

describe("heatmap24h", () => {
  it("sempre retorna 24 buckets", () => {
    const out = heatmap24h([]);
    expect(Object.keys(out).length).toBe(24);
  });

  it("buckets vazios sem eventos", () => {
    const out = heatmap24h([]);
    for (const v of Object.values(out)) {
      expect(v).toEqual({ info: 0, warning: 0, critical: 0 });
    }
  });

  it("conta evento por severity corretamente", () => {
    const now = Date.now();
    const events: FakeEvent[] = [
      { createdAt: new Date(now - 1000), severity: "critical" },
      { createdAt: new Date(now - 1000), severity: "info" },
      { createdAt: new Date(now - 3600_000 - 1000), severity: "warning" }
    ];
    const out = heatmap24h(events, now);
    const lastBucket = Object.values(out)[23];
    expect(lastBucket).toEqual({ info: 1, warning: 0, critical: 1 });
    const prevBucket = Object.values(out)[22];
    expect(prevBucket).toEqual({ info: 0, warning: 1, critical: 0 });
  });

  it("ignora eventos > 24h", () => {
    const now = Date.now();
    const events: FakeEvent[] = [
      { createdAt: new Date(now - 25 * 3600_000), severity: "info" }
    ];
    const out = heatmap24h(events, now);
    for (const v of Object.values(out)) {
      expect(v.info).toBe(0);
    }
  });
});
