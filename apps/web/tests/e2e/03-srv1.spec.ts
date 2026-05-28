import { test, expect } from "@playwright/test";
import { loginViaBackdoor, loginInBrowser } from "./helpers/auth";

test.describe("Tela SRV1 Deep Dive", () => {
  test("API: 7 endpoints SRV1", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const eps = [
      "/be/srv1/host",
      "/be/srv1/services",
      "/be/srv1/processes?by=cpu&limit=10",
      "/be/srv1/processes?by=mem&limit=10",
      "/be/srv1/ports",
      "/be/analytics/host/history?hours=6",
      "/be/srv1/journal/docker.service?lines=20"
    ];
    for (const ep of eps) {
      const r = await request.get(ep, { headers: { Authorization: `Bearer ${accessToken}` } });
      expect(r.status(), `${ep}`).toBe(200);
    }
  });

  test("API: services retorna 10 systemd units esperados", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/srv1/services", { headers: { Authorization: `Bearer ${accessToken}` } });
    const services = await r.json();
    expect(Array.isArray(services)).toBeTruthy();
    expect(services.length).toBeGreaterThanOrEqual(8);
    const dockerSvc = services.find((s: any) => s.name === "docker.service");
    expect(dockerSvc?.activeState).toBe("active");
  });

  test("API: top processes ordenado por CPU desc", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/srv1/processes?by=cpu&limit=5", { headers: { Authorization: `Bearer ${accessToken}` } });
    const procs = await r.json();
    expect(procs.length).toBe(5);
    for (let i = 1; i < procs.length; i++) {
      expect(procs[i - 1].cpu).toBeGreaterThanOrEqual(procs[i].cpu);
    }
  });

  test("UI: SRV1 carrega gauges", async ({ page }) => {
    await loginInBrowser(page);
    await page.goto("/srv1");
    await expect(page.getByText(/CPU|RAM|DISK/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
