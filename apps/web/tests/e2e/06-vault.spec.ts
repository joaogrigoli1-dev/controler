import { test, expect } from "@playwright/test";
import { loginViaBackdoor, loginInBrowser } from "./helpers/auth";

test.describe("Tela Vault SSM", () => {
  test("API: vault/params retorna >=50 parâmetros", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/vault/params", { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(r.ok()).toBeTruthy();
    const params = await r.json();
    expect(params.length).toBeGreaterThanOrEqual(50);
  });

  test("API: vault/params SecureString vem mascarado", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/vault/params", { headers: { Authorization: `Bearer ${accessToken}` } });
    const params = await r.json();
    const secure = params.find((p: any) => p.type === "SecureString");
    expect(secure).toBeTruthy();
    expect(secure.value).toBe("•••"); // mascarado
  });

  test("API: filtro por project funciona", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/vault/params?project=controler", { headers: { Authorization: `Bearer ${accessToken}` } });
    const params = await r.json();
    expect(params.length).toBeGreaterThan(0);
    expect(params.every((p: any) => p.project === "controler")).toBeTruthy();
  });

  test("API: reveal sem OTP retorna 403", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.post("/be/vault/reveal", {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      data: { name: "/controler/coolify_token" }
    });
    expect(r.status()).toBe(403); // OTP reauth exigido
  });

  test("UI: Vault renderiza tabela", async ({ page }) => {
    await loginInBrowser(page);
    await page.goto("/vault");
    await expect(page.getByText(/Vault|SSM/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
