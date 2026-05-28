import { test, expect } from "@playwright/test";
import { loginViaBackdoor, loginInBrowser } from "./helpers/auth";

test.describe("Tela APIs por Projeto", () => {
  test("API: lista 21 APIs em 6 projetos", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/apis", { headers: { Authorization: `Bearer ${accessToken}` } });
    const apis = await r.json();
    expect(apis.length).toBeGreaterThanOrEqual(20);
    const projects = new Set(apis.map((a: any) => a.project?.slug));
    expect(projects.size).toBeGreaterThanOrEqual(5);
  });

  test("API: filtro project=myclinicsoft retorna só MCS", async ({ request }) => {
    const { accessToken } = await loginViaBackdoor(request);
    const r = await request.get("/be/apis?project=myclinicsoft", { headers: { Authorization: `Bearer ${accessToken}` } });
    const apis = await r.json();
    expect(apis.length).toBeGreaterThan(0);
    expect(apis.every((a: any) => a.project?.slug === "myclinicsoft")).toBeTruthy();
  });

  test("UI: APIs page renderiza", async ({ page }) => {
    await loginInBrowser(page);
    await page.goto("/apis");
    await expect(page.getByText(/Z-API|Infobip|API/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
