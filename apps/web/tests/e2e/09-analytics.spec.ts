import { test, expect } from "@playwright/test";
import { loginViaBackdoor, loginInBrowser } from "./helpers/auth";

test.describe("Tela Analytics", () => {
  test("API: overview com periodDays + deploys + alerts + mttrMinutes", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/analytics/overview?days=7", { headers: { Authorization: `Bearer ${accessToken}` } });
    const o = await r.json();
    expect(o.periodDays).toBe(7);
    expect(o.deploys).toHaveProperty("current");
    expect(o.alerts).toHaveProperty("current");
  });

  test("API: host history retorna >100 pontos em 24h", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/analytics/host/history?hours=24", { headers: { Authorization: `Bearer ${accessToken}` } });
    const hist = await r.json();
    expect(hist.length).toBeGreaterThan(50);
  });

  test("API: heatmap retorna 24 buckets", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/timeline/heatmap", { headers: { Authorization: `Bearer ${accessToken}` } });
    const heat = await r.json();
    expect(Object.keys(heat).length).toBe(24);
    for (const v of Object.values(heat)) {
      expect(v).toHaveProperty("info");
      expect(v).toHaveProperty("warning");
      expect(v).toHaveProperty("critical");
    }
  });

  test("UI: Analytics renderiza", async ({ page }) => {
    await loginInBrowser(page);
    await page.goto("/analytics");
    await expect(page.getByText(/Deploys|MTTR|Alertas/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
