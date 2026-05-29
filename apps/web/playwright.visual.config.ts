/**
 * Config separada para audit visual.
 * Sequencial, sem retry, output em tests/visual/screenshots/
 */
import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL || "https://noc.controler.net.br";

export default defineConfig({
  testDir: "./tests/visual",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000
  }
});
