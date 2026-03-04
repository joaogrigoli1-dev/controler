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
