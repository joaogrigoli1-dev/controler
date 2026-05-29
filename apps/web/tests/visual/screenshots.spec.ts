/**
 * Visual audit: captura screenshots de todas as 8 telas em desktop + mobile.
 *
 * Como rodar:
 *   pnpm --filter @controler/web exec playwright install chromium  # 1x
 *   pnpm --filter @controler/web exec playwright test tests/visual --reporter=list
 *
 * Saída: tests/visual/screenshots/<tela>-<viewport>.png
 *
 * Não usa o config principal (playwright.config.ts) — define viewport dinâmico.
 */

import { test, expect } from "@playwright/test";
import { loginInBrowser } from "../e2e/helpers/auth";
import * as fs from "fs";
import * as path from "path";

const OUTPUT_DIR = path.join(__dirname, "screenshots");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const TELAS = [
  { path: "/login",     name: "01-login",     login: false },
  { path: "/overview",  name: "02-overview",  login: true  },
  { path: "/srv1",      name: "03-srv1",      login: true  },
  { path: "/coolify",   name: "04-coolify",   login: true  },
  { path: "/hestia",    name: "05-hestia",    login: true  },
  { path: "/vault",     name: "06-vault",     login: true  },
  { path: "/apis",      name: "07-apis",      login: true  },
  { path: "/alerts",    name: "08-alerts",    login: true  },
  { path: "/analytics", name: "09-analytics", login: true  }
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet",  width: 768,  height: 1024 },
  { name: "mobile",  width: 390,  height: 844 }
];

test.describe("Visual audit — 9 telas × 3 viewports = 27 screenshots", () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`Viewport: ${viewport.name} (${viewport.width}×${viewport.height})`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      for (const tela of TELAS) {
        test(`${tela.name} ${viewport.name}`, async ({ page }) => {
          if (tela.login) {
            await loginInBrowser(page);
          }
          await page.goto(tela.path);
          // Espera carregar (mas não bloqueia se WS continua aberto)
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => null);
          // Wait pra animações terminarem
          await page.waitForTimeout(1500);
          const outPath = path.join(OUTPUT_DIR, `${tela.name}-${viewport.name}.png`);
          await page.screenshot({ path: outPath, fullPage: true });
          console.log(`  ✓ ${outPath}`);
        });
      }
    });
  }
});
