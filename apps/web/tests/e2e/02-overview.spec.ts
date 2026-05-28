import { test, expect } from "@playwright/test";
import { loginViaBackdoor, loginInBrowser } from "./helpers/auth";

test.describe("Tela Overview (Mission Control)", () => {
  test("API: todos os 6 endpoints da Overview retornam 200", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const eps = [
      "/be/srv1/host",
      "/be/srv1/containers",
      "/be/coolify/apps",
      "/be/alerts/summary",
      "/be/timeline?limit=8",
      "/be/hestia/sites"
    ];
    for (const ep of eps) {
      const r = await request.get(ep, { headers: { Authorization: `Bearer ${accessToken}` } });
      expect(r.status(), `${ep}`).toBe(200);
    }
  });

  test("API: srv1/host tem campos numéricos válidos", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/srv1/host", { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await r.json();
    expect(typeof body.cpuPercent).toBe("number");
    expect(typeof body.memTotalMb).toBe("number");
    expect(typeof body.diskTotalGb).toBe("number");
    expect(Array.isArray(body.loadAvg)).toBeTruthy();
    expect(body.loadAvg).toHaveLength(3);
  });

  test("API: containers retorna >0 containers do SRV1", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/srv1/containers", { headers: { Authorization: `Bearer ${accessToken}` } });
    const containers = await r.json();
    expect(Array.isArray(containers)).toBeTruthy();
    expect(containers.length).toBeGreaterThan(10); // SRV1 tem ~40 containers
  });

  test("UI: overview renderiza KPI tiles após login", async ({ page }) => {
    await loginInBrowser(page);
    await page.goto("/overview");
    await expect(page.getByText(/CONTAINERS/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/CPU SRV1/i).first()).toBeVisible();
  });
});
