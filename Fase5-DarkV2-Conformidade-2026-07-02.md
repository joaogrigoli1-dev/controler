# FASE 5 — Conformidade dark-v2 v4 "Premium" — 2026-07-02

Varredura e limpeza de estilo local herdado em `apps/web/app/**/*.tsx` e `apps/web/components/**/*.tsx`.
Executado por @design (Fable 5). Typecheck `npx tsc --noEmit` em `apps/web`: **exit 0**.

---

## 1. Fundação v4 (já aplicada antes desta varredura — não alterada aqui)

- `app/globals.css` — tokens v4: `--accent` teal (#2dd4bf), `--cyan` reapontado p/ indigo (#818cf8, 2ª série), `--green/--yellow/--red/--purple/--muted` recalibrados.
- `app/layout.tsx` — Inter (UI) + JetBrains Mono (dados); Clash Display / Plus Jakarta removidos (resta só o comentário documentando).
- `tailwind.config.ts` — mapeado aos tokens.
- `components/ui/KpiTile`, `components/layout/Sidebar` — padrão v4.
- `components/noc/TimeSeriesChart` — `export const SERIES = { teal:"#2dd4bf", indigo:"#818cf8", amber:"#fbbf24", rose:"#fb7185" }` e `TOOLTIP_STYLE` atualizado (fonte única de cor de série e de tooltip).
- **Ajuste feito nesta FASE 5 na fundação:** as `ReferenceLine` warn/crit do TimeSeriesChart ainda usavam hsl v3 cru (`hsl(45 95% 53%)` / `hsl(0 90% 71%)`) → migradas para `SERIES.amber` / `SERIES.rose`.

## 2. Tabela antes/depois por regra (violações)

| Regra | Descrição | Antes | Depois |
|---|---|---:|---:|
| R1 | rounded-full fora de dot/pill/track; rounded-2xl/3xl | 0 | 0 |
| R7 | hex/hsl cru em página | 17 | 0 |
| R7 | bg-white sólido / text-gray / text-slate / bg-slate | 0 | 0 |
| R7 | resquício Clash Display / Plus Jakarta | 0 | 0 |
| R11 | window.confirm / window.alert / alert() | 0 | 0 |
| R11 | fetch sem estado de erro visível (telas pré-FASE 4) | 6 fetches (hestia×2, apis×1, alerts×3) | 0 |
| R12 | texto informativo abaixo de AA (text-white/30–55) | 103 ocorrências → 62 eram texto informativo | 0 (41 exceções legítimas mantidas) |
| R13 | backdrop-blur fora de sidebar/toolbar/modal; fundos v3 inline | 0 | 0 |

Detalhe R7 (antes): analytics 6 (SEV_COLORS×3 + série×2 + fallback `#888`), srv1 2, srv1/containers/[name] 7, login 1, TimeSeriesChart 2 (componente, warn/crit).

## 3. Correções aplicadas (arquivo → o quê)

### R7 — paleta via SERIES/tokens
- `app/(dashboard)/analytics/page.tsx` — `SEV_COLORS` local com hsl v3 → derivado de `SERIES` importado (`info: SERIES.teal, warning: SERIES.amber, critical: SERIES.rose`); séries CPU/RAM → `SERIES.teal`/`SERIES.indigo`; fallback do Pie `"#888"` → `"hsl(var(--muted))"`. `TOOLTIP_STYLE` já era o importado.
- `app/(dashboard)/srv1/page.tsx` — séries CPU/RAM → `SERIES.teal`/`SERIES.indigo` (+ import de `SERIES`).
- `app/(dashboard)/srv1/containers/[name]/page.tsx` — CPU → `SERIES.teal`; Memória → `SERIES.indigo` + tendência → `SERIES.amber`; Rede RX/TX → `SERIES.teal`/`SERIES.indigo`; Block IO r/w → `SERIES.indigo`/`SERIES.amber` (+ import). Sem clash de cor dentro do mesmo chart.
- `app/(auth)/login/page.tsx` — glow halo `hsl(248 92% 70% / 0.18)` (roxo v3) → `hsl(var(--purple) / 0.18)`.
- `components/noc/TimeSeriesChart.tsx` — ReferenceLine warn/crit → `SERIES.amber`/`SERIES.rose`.

### R11 — error state visível (telas pré-FASE 4)
Padrão mínimo `CardError` de `@/components/noc/CardError` com `onRetry` via `mutate` do SWR:
- `app/(dashboard)/hestia/page.tsx` — errors de `sites-all` e `mail-stack` capturados; CardError no card Mail Stack e card dedicado p/ sites.
- `app/(dashboard)/apis/page.tsx` — error de `apis` capturado; CardError acima da lista.
- `app/(dashboard)/alerts/page.tsx` — errors de summary/logs/rules capturados; CardError acima dos KPIs, no card "Regras configuradas" e em "Disparos recentes".
- vault já tinha error states (FE-04) — nada a fazer.

### R12 — contraste AA (62 correções; /60 p/ labels/metadados, /70 p/ subtítulos/descrições)
- **Componentes (corrige em cascata):** `KpiTile` (label /40→/60, sub /50→/60, delta flat /40→/60); `CardError` (EmptyState /40→/60); `ErrorBoundary` (msg /40→/60); `ContainerHeatmap` (empty msg /40→/60); `CommandPalette` ("Nada encontrado." /40→/60); `Sidebar` (descrição do modal de logout /50→/70); `OtpActionButton` (status "Código enviado…" /40→/60).
- `login` — subtítulos /50→/70 (×2), labels de campo /40→/60 (×2), link "Trocar número" /40→/60.
- `vault` — contagem de parâmetros /40→/60, valor revelado /50→/70, thead audit /40→/60, nome do parâmetro no modal /50→/70.
- `analytics` — abas de janela inativas /50→/60, legenda de disponibilidade /40→/60, theads /40→/60, coluna tipo /50→/60, breakdown por canal /40→/60, meta de deploys /40→/60, rodapé metodológico /30→/60.
- `overview` — "/100", labels de sinais, unidades, grid de resumo, "clique para drill-down", empty deploy /40→/60; detail do mais importante e "Nada crítico agora" /50→/70.
- `srv1` — labels PSI/Swap/Load, sufixos de unidade, TCP retrans, descrição de service, empty processos, contagens, "clique para drill-down" /40→/60 (×12); linhas si/so e W/C /50→/60 (×2).
- `coolify` — status do app /40→/60; stats ok/fail/% /50→/60.
- `coolify/[uuid]` — link voltar, meta row do header, preview de env /40→/60.
- `srv1/containers` — labels das barras de recurso e contador visível/total /40→/60.
- `srv1/containers/[name]` — link voltar /40→/60.
- `hestia` — empty state do mail /40→/60.
- `apis` — contagem "(n)" no título de seção /30→/60.
- `alerts` — labels do form de teste (×3), meta de regras, thead de disparos /40→/60.

## 4. Exceções legítimas mantidas (com justificativa)

- **R7:** `app/layout.tsx` `themeColor: "#05060d"` — metadata do Next (meta tag `theme-color` exige literal; não aceita var CSS). Único hex fora de `components/`.
- **R7:** `SERIES` (hex) e `TOOLTIP_STYLE` (rgba) vivem em `components/noc/TimeSeriesChart.tsx` — componente compartilhado é o nível permitido para tokens.
- **R1:** todos os 12 `rounded-full` são dots de status, tracks de progress bar (h-1/h-1.5) e skeleton circular de Gauge — usos permitidos; nenhum botão/menu/aba.
- **R13:** os 5 `backdrop-blur` estão em Topbar (toolbar), CommandPalette/Sidebar-logout/vault-OTP/OtpActionButton (modais/overlays) — usos permitidos.
- **R12 (41 ocorrências mantidas):** kbd hints (⌘K/ESC/atalhos), placeholders e ícone de busca, contadores aria-hidden ("n/6 dígitos"), wordmark "noc", label TZ do relógio, botão fechar do Toast (ícone com hover), timestamps repetitivos de lista (audit, disparos, deploys, uptime), identificadores mono repetitivos (uuid, sha, branch, image, fqdn, containerName, baseUrl, IP, hint, responseMs, process de porta), índices de ranking (1–5), placeholders de ausência ("—", "sem fqdn"), tile de container não-rodando (estado disabled), `<pre>` de debug JSON, footnote "Entrega via Z-API" do login (microcopy decorativa).

## 5. Verificação

- Greps re-executados após correções: R7 hsl/hex cru em página = 0; R11 fetch sem erro = 0; R12 restantes = 41 (todas exceções acima); R1/R13 = 0.
- `cd apps/web && npx tsc --noEmit` → **exit 0**.
- `apps/api` não foi tocado nesta fase.

## 6. Pendências (para o João)

- **Validação visual em navegador (1280 e 1920):** sem browser neste ambiente. Conferir especialmente: (a) charts do drill-down de container (novas cores teal/indigo/amber em Rede e Block IO); (b) heatmap + pie de severidade no /analytics (SEV_COLORS agora teal/amber/rose); (c) glow do login com `--purple` v4; (d) legibilidade dos textos elevados a /60–/70 (nada deve ter ficado "gritando"); (e) simular falha de API em /hestia, /apis e /alerts para ver os novos CardError.
- Decisão de design opcional: RX/TX usarem teal/indigo perde a semântica antiga "verde=download"; se quiser semântica de cor, trocar RX para `hsl(var(--green))` (token, ainda conforme R7).
