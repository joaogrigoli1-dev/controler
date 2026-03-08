# FASE 7 — Análise do Controler (Python FastAPI)

**Data:** 2026-03-05
**Repo:** `joaogrigoli1-dev/controler` (branch: develop, 5 commits)
**Status:** Ferramenta local funcional, mas apontando para servidor antigo (srv2)

---

## 1. Resumo

O Controler é uma **ferramenta local de automação DevOps** que roda no Mac do desenvolvedor (NÃO no servidor). É um app FastAPI com dashboard web em `http://localhost:3001` que:

- Monitora pastas de projetos locais para detectar mudanças
- Usa Claude API (Anthropic SDK) para sugestões de auto-commit
- Faz deploy do MyClinicSoft via SSH + atomic releases
- Sincroniza dados WhatsApp de produção para dev local
- Verifica status dos serviços no servidor

**Linguagens:** Python 66.8%, HTML 33.2%

---

## 2. Arquitetura

```
Mac do desenvolvedor
├── controler.py          (830 linhas) — FastAPI entry point, port 3001
├── core/
│   ├── agent.py          — Agente IA com Claude API
│   ├── tools.py          (230 linhas) — execute_command, ssh_command, read/write/list
│   └── database.py       — SQLite (projects, actions, rules, memory)
├── devops/
│   ├── deploy_myclinicsoft.py  (688 linhas) — Deploy com atomic releases
│   └── whatsdev_sync.py       — Sync WhatsApp prod → dev
├── config/
│   └── settings.yaml     — Configuração geral
├── static/               — Dashboard HTML
└── requirements.txt      — fastapi, uvicorn, pyyaml
```

---

## 3. Endpoints Principais

| Endpoint | Método | Função |
|----------|--------|--------|
| `/api/projects` | GET | Lista projetos em ~/Documents/DEV/ |
| `/api/projects/{id}` | GET | Detalhes do projeto + ações + regras |
| `/api/myclinicsoft/deploy/stream` | GET | SSE: Deploy em tempo real (6 min timeout) |
| `/api/myclinicsoft/whatsdev-sync/stream` | GET | SSE: Sync WhatsApp (5 min timeout) |
| `/api/myclinicsoft/last-update` | GET | Última modificação nos arquivos |
| `/api/myclinicsoft/status` | GET | Health check do servidor (app + buffer + SSH) |
| `/api/memory/*` | CRUD | Memória persistente (SQLite) |

---

## 4. Deploy Flow (deploy_myclinicsoft.py)

```
1. develop (local) → PR → merge → main (GitHub)
2. Controler detecta merge na main
3. SSH para servidor: git pull + npm install + build
4. Atomic release: cria nova pasta em releases/YYYYMMDD-HHMMSS/
5. Symlink: current → nova release
6. Drizzle migrations
7. Health check: http://localhost:5000/api/health
8. Rollback automático se health check falhar
9. Limpa releases antigas (mantém últimas 5)
```

**Shared folder** (sobrevive entre releases):
- `.env` — variáveis de ambiente
- `uploads/` — arquivos enviados
- `.storage/` — dados persistentes

---

## 5. PROBLEMAS CRÍTICOS

### 5.1 ❌ SSH aponta para servidor antigo (srv2)

**`core/tools.py` linha 94:**
```python
def ssh_command(command: str, host: str = "187.77.40.102", ...)
```

**`devops/deploy_myclinicsoft.py` linha 45:**
```python
SERVER_IP = "187.77.40.102"  # srv2 — SERVIDOR ANTIGO!
```

O Controler **toda a comunicação com o servidor** usa SSH para `187.77.40.102` (srv2), mas a migração está sendo feita para `62.72.63.18` (srv1).

### 5.2 ❌ SSH porta 22 fechada no srv1

Mesmo se atualizarmos o IP para srv1, a porta 22 de SSH **não está aberta** no srv1. Todos os comandos via `ssh_command` vão falhar.

### 5.3 ❌ Deploy incompatível com Coolify

O deploy atual usa:
1. SSH + git pull + npm build no servidor
2. Atomic releases com symlinks
3. Gerenciamento manual de releases

O srv1 usa **Coolify** que gerencia deploys automaticamente via:
1. GitHub webhooks
2. Docker build + container restart
3. Sem symlinks ou releases manuais

O pipeline de deploy do Controler é **fundamentalmente incompatível** com a arquitetura Coolify.

### 5.4 ⚠️ Health check URL correta

Positivo: `HEALTH_URL = "http://localhost:5000/api/health"` — porta 5000 está correta para o MyClinicSoft no srv1.

### 5.5 ⚠️ REMOTE_BASE corrigido

O commit mais recente (363db8d) corrigiu `REMOTE_BASE` para `/app/myclinicsoft` — mas isso refere-se à estrutura no srv2, que não existe no Coolify.

---

## 6. Recomendações

### Opção A: Adaptar Controler para Coolify API (Recomendado)

Reescrever `ssh_command` e `deploy_myclinicsoft.py` para usar:

```python
# Em vez de SSH:
COOLIFY_URL = "http://62.72.63.18:8000/api/v1"
COOLIFY_TOKEN = "2|PACNSa1HBN0AkS5LKsp4x5YeNS95QirqOYyAsLg30ef58ece"

# Deploy via Coolify API:
# POST /applications/{uuid}/restart
# POST /deployments (webhook trigger)

# Status check via Coolify API:
# GET /applications/{uuid}
```

**Benefícios:** Mantém o dashboard local, integra com Coolify nativamente.

### Opção B: Abrir SSH no srv1

Configurar `sshd` no srv1 para permitir acesso SSH:
```bash
apt install openssh-server
systemctl enable sshd
ufw allow 22/tcp
```

**Riscos:** Aumenta superfície de ataque, duplica gerenciamento com Coolify.

### Opção C: Usar Coolify como CI/CD único

Abandonar o deploy via Controler e usar exclusivamente:
1. GitHub webhooks → Coolify auto-deploy
2. Controler mantém apenas: monitoring, status check, WhatsApp sync

**Benefícios:** Simplifica arquitetura, Coolify já faz deploy melhor.

---

## 7. Status da Integração com srv1

| Componente | srv2 (antigo) | srv1 (novo) | Status |
|------------|---------------|-------------|--------|
| SSH | ✅ Funciona | ❌ Porta fechada | Bloqueado |
| Deploy | ✅ Atomic releases | ❌ Incompatível com Coolify | Precisa reescrita |
| Status check | ✅ Via SSH | ⚠️ Possível via Coolify API | Adaptável |
| WhatsApp sync | ✅ Via SSH+psql | ⚠️ Possível via API direta | Adaptável |
| Health URL | ✅ :5000 | ✅ :5000 | OK |

---

## 8. Arquivo settings.yaml (pendente verificação)

Possivelmente contém configurações adicionais de SSH, API keys, etc. O repo é privado e não foi possível clonar no srv1 (sem credenciais Git configuradas).

---

## 9. Conclusão

O Controler é uma ferramenta local bem construída, mas **precisa de adaptação significativa** para funcionar com a nova infraestrutura Coolify no srv1. A recomendação principal é **Opção C**: usar Coolify como CI/CD e manter o Controler apenas para monitoramento e funcionalidades locais. O deploy deve ser automatizado via GitHub webhooks + Coolify.
