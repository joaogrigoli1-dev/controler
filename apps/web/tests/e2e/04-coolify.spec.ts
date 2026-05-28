import { test, expect } from "@playwright/test";
import { loginViaBackdoor, loginInBrowser } from "./helpers/auth";

test.describe("Tela Coolify", () => {
  test("API: lista exatamente 7 apps", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/coolify/apps", { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(r.ok()).toBeTruthy();
    const apps = await r.json();
    expect(Array.isArray(apps)).toBeTruthy();
    expect(apps.length).toBe(7);
    const names = apps.map((a: any) => a.name);
    expect(names).toContain("controler");
    expect(names).toContain("myclinicsoft");
  });

  test("API: app individual + envs + logs", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const uuid = "jckc0ccwssowwc0oocw80ogs"; // myclinicsoft
    const r1 = await request.get(`/be/coolify/apps/${uuid}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(r1.ok()).toBeTruthy();
    const r2 = await request.get(`/be/coolify/apps/${uuid}/envs`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(r2.ok()).toBeTruthy();
    const r3 = await request.get(`/be/coolify/apps/${uuid}/logs?lines=10`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(r3.ok()).toBeTruthy();
  });

  test("UI: Coolify lista apps", async ({ page }) => {
    await loginInBrowser(page);
    await page.goto("/coolify");
    await expect(page.getByText(/myclinicsoft/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
