/**
 * Helpers de autenticação para testes e2e.
 *
 * Usa o backdoor /be/auth/dev-otp + verify-code para obter JWT
 * sem precisar enviar/ler WhatsApp.
 *
 * Requer env DEV_BACKDOOR_TOKEN (default: token de dev local).
 */

import { Page, APIRequestContext, expect } from "@playwright/test";

export const PHONE = "5565984665555";
export const BACKDOOR =
  process.env.DEV_BACKDOOR_TOKEN || "jhgm_backdoor_2026_controler_recovery_x9k2m7";

export interface Session {
  accessToken: string;
  refreshToken?: string; // A-02: não vem mais no corpo (cookie httpOnly)
  user: { id: string; name: string; email: string; role: string; phone: string };
}

/** Pega um JWT válido fazendo OTP backdoor + verify. */
export async function loginViaBackdoor(request: APIRequestContext, baseUrl?: string): Promise<Session> {
  const url = (p: string) => (baseUrl ? `${baseUrl}${p}` : p);

  const otpRes = await request.post(url("/be/auth/dev-otp"), {
    headers: { "X-Dev-Token": BACKDOOR, "Content-Type": "application/json" },
    data: { phone: PHONE }
  });
  expect(otpRes.ok(), `dev-otp falhou: ${otpRes.status()}`).toBeTruthy();
  const { code } = await otpRes.json();

  const verifyRes = await request.post(url("/be/auth/verify-code"), {
    headers: { "Content-Type": "application/json" },
    data: { phone: PHONE, code }
  });
  expect(verifyRes.ok(), `verify-code falhou: ${verifyRes.status()}`).toBeTruthy();
  return verifyRes.json();
}

/**
 * Injeta sessão no browser. A-02: o refresh vai por cookie httpOnly (setado no
 * verify-code via a mesma BrowserContext do page.request). O app re-obtém o access
 * token via /auth/refresh no 1º 401. Basta cachear o `user` p/ o roteamento.
 */
export async function loginInBrowser(page: Page): Promise<Session> {
  const session = await loginViaBackdoor(page.request);
  await page.goto("/");
  await page.evaluate((s) => {
    localStorage.setItem("controler:user", JSON.stringify(s.user));
  }, session);
  return session;
}
