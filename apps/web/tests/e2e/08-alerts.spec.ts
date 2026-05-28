import { test, expect } from "@playwright/test";
import { loginViaBackdoor, loginInBrowser } from "./helpers/auth";

test.describe("Tela Alertas", () => {
  test("API: alerts summary com 6 chaves", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/alerts/summary", { headers: { Authorization: `Bearer ${accessToken}` } });
    const s = await r.json();
    for (const k of ["total", "critical", "warning", "info", "last24h", "silenced"]) {
      expect(s).toHaveProperty(k);
      expect(typeof s[k]).toBe("number");
    }
  });

  test("API: 8 regras seedadas", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/alerts/rules", { headers: { Authorization: `Bearer ${accessToken}` } });
    const rules = await r.json();
    expect(rules.length).toBeGreaterThanOrEqual(8);
    for (const rule of rules) {
      expect(rule).toHaveProperty("name");
      expect(rule).toHaveProperty("severity");
      expect(rule).toHaveProperty("channels");
    }
  });

  test("UI: Alertas renderiza KPIs", async ({ page }) => {
    await loginInBrowser(page);
    await page.goto("/alerts");
    await expect(page.getByText(/Críticos|Warnings|Total/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
