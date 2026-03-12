# CLAUDE.md — controler

## Memória automática

Este projeto usa o servidor MCP `memory-mcp` para armazenar contexto entre sessões.
Ao iniciar: `memory_search` com o tema da tarefa. Ao terminar: `memory_save` com o que foi feito.

---

## Sobre o projeto

**controler** — ferramenta Python de automação para desenvolvimento com IA.

**Localização:** `~/Documents/DEV/controler/`

**O que faz:**
- Monitora pastas de projetos para detectar mudanças
- Usa Claude API para auto-commit e deploy
- Integra com GitHub via git commands
- Tem DevOps scripts para deploy do myclinicsoft

**Stack:**
- Python 3.12 (via brew: `/opt/homebrew/bin/python3.12`)
- Claude API (Anthropic SDK)
- Shell scripts + subprocess

**Arquivos principais:**
- `controler.py` — entry point, SCAN_DIRS aponta para ~/Documents/DEV/
- `core/agent.py` — agente principal com prompt do sistema
- `core/tools.py` — ferramentas disponíveis para o agente
- `config/settings.yaml` — configuração geral
- `devops/deploy_myclinicsoft.py` — script de deploy
- `devops/whatsdev_sync.py` — sincronização WhatsApp dev

**Configuração:**
- SCAN_DIRS em `controler.py`: `["/Users/jhgm/Documents/DEV/myclinicsoft", "/Users/jhgm/Documents/DEV/controler"]`
- Chaves de API em variáveis de ambiente ou `config/settings.yaml`

---

## Regra de Deploy — Triangulação Obrigatória

**NUNCA editar diretamente no servidor (srv1/Coolify/prod).**

O fluxo correto é sempre:

```
Mac (dev local) → GitHub (main) → Coolify (prod)
```

1. **Mac (dev local)** — todas as edições de código acontecem aqui
2. **GitHub** — `git push origin main` — Coolify detecta e inicia o build
3. **Coolify (prod)** — deploy automático via webhook GitHub

**Script padrão:** `python3 devops/deploy_controler.py`
- Valida ausência de credenciais hardcoded (`devops/validate_no_secrets.sh`) antes de `git add`
- Faz commit + push para o GitHub
- Aciona o deploy no Coolify via API
- Aguarda status `running:healthy` e verifica HTTPS

**Segredos:** nunca no código. Ficam no **AWS SSM Parameter Store** (`/controler/*`).
- Em prod: IAM role do container busca automaticamente
- Em dev local: `aws ssm get-parameter --profile cowork-admin`

---

## Credenciais no SSM

| Parâmetro SSM | Variável de Ambiente |
|---|---|
| `/controler/coolify_token` | `COOLIFY_TOKEN` |
| `/controler/auth_user` | `BASIC_AUTH_USER` |
| `/controler/auth_pass` | `BASIC_AUTH_PASS` |
