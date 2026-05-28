import { test, expect } from "@playwright/test";
import { loginViaBackdoor, loginInBrowser } from "./helpers/auth";

test.describe("Tela Mail & Sites (Hestia re-escopado)", () => {
  test("API: sites retorna >=10 sites com statusCode", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/hestia/sites", { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(r.ok()).toBeTruthy();
    const sites = await r.json();
    expect(sites.length).toBeGreaterThanOrEqual(10);
    for (const s of sites) {
      expect(s).toHaveProperty("domain");
      expect(s).toHaveProperty("scope");
      expect(s).toHaveProperty("online");
    }
  });

  test("API: mail stack retorna >=4 containers mail", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/hestia/mail", { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(r.ok()).toBeTruthy();
    const mail = await r.json();
    expect(mail.length).toBeGreaterThanOrEqual(4); // mailserver + 4 roundcubes + nextcloud
  });

  test("UI: Mail & Sites renderiza", async ({ page }) => {
    await loginInBrowser(page);
    await page.goto("/hestia");
    await expect(page.getByText(/Mail Stack/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
