# Controler v3 → v4 — Tabela Comparativa KPIs

## Resumo executivo

**v3:** 18 KPIs · 9 telas Preact · auth Basic · SQLite · polling 30s  
**v4:** **66+ KPIs** · 8 telas Next.js · auth OTP WhatsApp + JWT + re-auth · Postgres · WebSocket realtime

## Por tela

### Overview (Home / Mission Control)

| KPI | v3 | v4 |
|-----|----|----|
| Containers running/total | ✅ | ✅ |
| Containers healthy (segregado) | ❌ | ✅ |
| CPU srv1 % | ✅ | ✅ |
| RAM srv1 % | ✅ | ✅ |
| Disk srv1 % | parcial | ✅ |
| Apps Coolify count | ❌ | ✅ |
| Sites online/total | ❌ | ✅ |
| Alertas 24h | parcial | ✅ |
| Críticos ativos | ❌ | ✅ |
| Load avg 1m/5m/15m | ❌ | ✅ |
| Uptime SRV1 | parcial | ✅ |
| Net in/out últimos 5min | ❌ | ✅ |
| Gauges animados CPU/RAM/Disk | parcial | ✅ |
| Lista de apps Coolify com status | ❌ | ✅ |
| Timeline recente (8 eventos) | parcial | ✅ |
| Status agregado (mail/postgres/traefik/backup) | ❌ | ✅ |

### SRV1 — Deep Dive

| KPI | v3 | v4 |
|-----|----|----|
| Gauges CPU/RAM/Disk | ✅ | ✅ |
| Histórico CPU/RAM 6h (line chart) | ❌ | ✅ |
| Uptime detalhado | ✅ | ✅ |
| Load avg detalhado | ❌ | ✅ |
| Net in/out histórico | ❌ | ✅ |
| Status 10 serviços systemd | parcial (6) | ✅ (10) |
| Top processos CPU | ❌ | ✅ |
| Top processos MEM | ❌ | ✅ |
| Portas em escuta (ss -tlnp) | ❌ | ✅ |
| Journalctl por serviço | ❌ | ✅ |
| Restart serviço (com OTP) | ❌ | ✅ |
| Restart container (com OTP) | ❌ | ✅ |

### Coolify

| KPI | v3 | v4 |
|-----|----|----|
| Lista de apps com status | parcial | ✅ |
| FQDN clicável | ❌ | ✅ |
| Git branch + commit | ❌ | ✅ |
| Env vars (mascaradas) | ❌ | ✅ |
| Logs em tempo real (100 linhas) | ❌ | ✅ |
| Deploy com OTP | ❌ | ✅ |
| Restart/Stop/Start com OTP | ❌ | ✅ |
| Auto-refresh 30s | ❌ | ✅ |

### Mail & Sites (re-escopo HestiaCP)

| KPI | v3 | v4 |
|-----|----|----|
| Lista de sites Coolify | ❌ | ✅ |
| Lista de sites nginx | ❌ | ✅ |
| Status HTTP por site | ❌ | ✅ |
| Response time por site | ❌ | ✅ |
| SSL expira em N dias | ❌ | ✅ |
| Mail stack (mailserver+roundcube+nextcloud) | ❌ | ✅ |
| Status por container mail | ❌ | ✅ |

### Vault

| KPI | v3 | v4 |
|-----|----|----|
| Lista params SSM | ✅ | ✅ |
| Agrupado por projeto | parcial (por prefix) | ✅ |
| Filtro de busca | ❌ | ✅ |
| Reveal com toggle simples | ✅ | substituído |
| Reveal com re-auth OTP WhatsApp | ❌ | ✅ |
| Audit log (quem revelou o quê) | ❌ | ✅ |
| Modal OTP elegante | ❌ | ✅ |

### APIs (NOVA TELA)

| KPI | v3 | v4 |
|-----|----|----|
| Lista APIs por projeto | ❌ | ✅ (8 APIs MyClinicSoft semeadas) |
| Status saúde (healthy/degraded/down) | ❌ | ✅ |
| Response time última checagem | ❌ | ✅ |
| Botão "Pingar todas" | ❌ | ✅ |
| Link para SSM key | ❌ | ✅ |
| Link docs externos | ❌ | ✅ |

### Alertas

| KPI | v3 | v4 |
|-----|----|----|
| Total | parcial | ✅ |
| Críticos / warnings | parcial | ✅ |
| 24h | ❌ | ✅ |
| Silenciados | ❌ | ✅ |
| Painel de teste | ✅ | ✅ |
| CRUD de regras | ❌ | ✅ |
| Histórico de disparos com canal | ❌ | ✅ |
| Severidade visual destacada | parcial | ✅ |

### Analytics (NOVA TELA)

| KPI | v3 | v4 |
|-----|----|----|
| Deploys 7d com Δ vs 7d anteriores | ❌ | ✅ |
| Alertas 7d com Δ | ❌ | ✅ |
| Críticos 7d | ❌ | ✅ |
| MTTR (minutos) | ❌ | ✅ |
| Line chart CPU/RAM 24h | parcial | ✅ |
| Heatmap eventos 24h (bar stacked) | ❌ | ✅ |
| Deploys por projeto 30d (success rate bar) | ❌ | ✅ |

## Segurança

| Item | v3 | v4 |
|------|----|----|
| Basic Auth com rate limit (5x/15min) | ✅ | substituído |
| OTP WhatsApp para login | ❌ | ✅ |
| JWT access 15min + refresh 7d | ❌ | ✅ |
| Single-session policy | ❌ | ✅ |
| Re-auth OTP para reveal | ❌ | ✅ |
| Audit log vault | ❌ | ✅ |
| Concurrent login detection | ❌ | ✅ (espelho MCS) |
| Rate limit per endpoint (não só auth) | ❌ | ✅ (Fastify rate-limit) |
| CSP strict (sem 'unsafe-inline') | parcial | ✅ |
| Helmet headers | parcial | ✅ |

## Realtime

| Item | v3 | v4 |
|------|----|----|
| WebSocket | ❌ | ✅ (Socket.IO) |
| Polling | 30s | 30s SWR + push WS |
| Indicador "LIVE" no header | ❌ | ✅ |
| Connection status badge | ❌ | ✅ |

## Performance

| Métrica | v3 | v4 alvo |
|---------|----|---------|
| TTI | ~1.8s cold | <2s |
| Cache backend | nenhum | Redis com TTL por endpoint |
| Bundle JS | 0 KB (CDN) | ~200 KB (Next standalone) |
| Backend RAM | ~150 MB | <300 MB |

## TOTAL POR TELA

| Tela | v3 KPIs | v4 KPIs | Δ |
|------|---------|---------|---|
| Overview | 4 | 16 | +12 |
| SRV1 | 4 | 12 | +8 |
| Coolify | 1 | 8 | +7 |
| Mail & Sites | 0 | 7 | +7 |
| Vault | 2 | 7 | +5 |
| APIs | 0 | 6 | +6 (nova) |
| Alertas | 3 | 8 | +5 |
| Analytics | 0 | 7 | +7 (nova) |
| **TOTAL** | **14** | **71** | **+57** |
