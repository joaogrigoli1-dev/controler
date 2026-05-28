import { test, expect } from "@playwright/test";
import { loginViaBackdoor, PHONE } from "./helpers/auth";

test.describe("Auth flow", () => {
  test("backend health responde 200 + version 4", async ({ request }) => {
    const r = await request.get("/be-health");
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.version).toBe("4.0.0");
    expect(body.status).toBe("ok");
    expect(body.services.db).toBe("ok");
    expect(body.services.redis).toBe("ok");
  });

  test("OTP request-code retorna success", async ({ request }) => {
    const r = await request.post("/be/auth/request-code", {
      headers: { "Content-Type": "application/json" },
      data: { phone: PHONE }
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.success).toBe(true);
  });

  test("backdoor dev-otp + verify-code emite JWT válido", async ({ request }) => {
    const s = await loginViaBackdoor(request);
    expect(s.accessToken.length).toBeGreaterThan(100);
    expect(s.refreshToken.length).toBeGreaterThanOrEqual(64);
    expect(s.user.phone).toBe(PHONE);
    expect(s.user.role).toBe("admin");
  });

  test("tela de login renderiza title correto", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveTitle(/Controler/);
    await expect(page.getByText(/Entrar/i)).toBeVisible();
  });

  test("endpoint protegido sem token retorna 401", async ({ request }) => {
    const r = await request.get("/be/srv1/host");
    expect(r.status()).toBe(401);
  });
});
