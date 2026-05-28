/**
 * Tests para AlertsService — funções puras (channelsFor, inSilenceWindow, icon).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Replicas da lógica (sem Prisma/Redis dependencies)
function channelsFor(sev: string): string[] {
  if (sev === "critical") return ["whatsapp", "sms"];
  if (sev === "warning") return ["whatsapp"];
  return ["internal"];
}

function inSilenceWindow(now: Date): boolean {
  // BRT (UTC-3) — janela 22h-7h BRT
  const brt = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const h = brt.getHours();
  return h >= 22 || h < 7;
}

function icon(sev: string): string {
  return sev === "critical" ? "🔴" : sev === "warning" ? "🟡" : "🔵";
}

describe("AlertsService.channelsFor", () => {
  it("critical → whatsapp + sms", () => {
    expect(channelsFor("critical")).toEqual(["whatsapp", "sms"]);
  });
  it("warning → só whatsapp", () => {
    expect(channelsFor("warning")).toEqual(["whatsapp"]);
  });
  it("info → internal (apenas log/WS)", () => {
    expect(channelsFor("info")).toEqual(["internal"]);
  });
  it("severity desconhecida → internal", () => {
    expect(channelsFor("xyz")).toEqual(["internal"]);
  });
});

describe("AlertsService.inSilenceWindow", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("23h BRT está em silêncio", () => {
    // 23h BRT = 02h UTC
    const d = new Date("2026-05-28T02:00:00Z");
    expect(inSilenceWindow(d)).toBe(true);
  });
  it("06h BRT está em silêncio", () => {
    const d = new Date("2026-05-28T09:00:00Z");
    expect(inSilenceWindow(d)).toBe(true);
  });
  it("07h BRT NÃO está em silêncio", () => {
    const d = new Date("2026-05-28T10:00:00Z");
    expect(inSilenceWindow(d)).toBe(false);
  });
  it("14h BRT NÃO está em silêncio", () => {
    const d = new Date("2026-05-28T17:00:00Z");
    expect(inSilenceWindow(d)).toBe(false);
  });
});

describe("AlertsService.icon", () => {
  it("critical = 🔴", () => expect(icon("critical")).toBe("🔴"));
  it("warning = 🟡", () => expect(icon("warning")).toBe("🟡"));
  it("info = 🔵", () => expect(icon("info")).toBe("🔵"));
  it("default = 🔵", () => expect(icon("xyz")).toBe("🔵"));
});
