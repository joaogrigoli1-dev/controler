/**
 * Playwright config — smoke tests para Controler NOC.
 *
 * Como rodar:
 *   pnpm --filter @controler/web exec playwright install chromium  # 1x
 *   pnpm --filter @controler/web test:e2e                          # roda contra prod
 *   pnpm --filter @controler/web test:e2e:local                    # roda contra http://localhost:3000
 *
 * Login: usa backdoor /be/auth/dev-otp (precisa DEV_BACKDOOR_TOKEN no env).
 */

import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL || "https://noc.controler.net.br";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // sequencial: backdoor OTP é throttle-sensitive
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "playwright-report/results.json" }]
  ],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
