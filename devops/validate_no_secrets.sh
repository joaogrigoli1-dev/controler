#!/bin/bash
# validate_no_secrets.sh — Verifica credenciais hardcoded no código do controler
# Uso: bash devops/validate_no_secrets.sh
# Retorna exit 0 se limpo, exit 1 se encontrar credenciais

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Verificando credenciais hardcoded no controler ==="
echo "Diretório: $ROOT"
echo ""

PATTERNS='password\s*=\s*["\x27][^"\x27$\{<]{4,}|passwd\s*=\s*["\x27][^"\x27$\{<]{4,}|secret\s*=\s*["\x27][^"\x27$\{<]{8,}|token\s*=\s*["\x27][^"\x27$\{<]{8,}|api_key\s*=\s*["\x27][^"\x27$\{<]{8,}|AUTH_PASS\s*=\s*["\x27][^"\x27$\{<]{4,}'

FOUND=$(grep -rn \
  --include="*.py" --include="*.yaml" --include="*.yml" \
  --include="*.sh" --include="*.toml" \
  --exclude-dir=.git --exclude-dir=__pycache__ --exclude-dir=venv \
  --exclude="*.example" --exclude="validate_no_secrets.sh" \
  -iE "$PATTERNS" . \
  | grep -v "os\.environ\|os\.getenv\|get_ssm\|_get_ssm\|getParameter\|SSM\|CHANGE_ME\|<sua_" \
  || true)

if [ -z "$FOUND" ]; then
  echo "✅ Nenhuma credencial hardcoded encontrada!"
  echo ""
  echo "Checklist SSM:"
  echo "  ✅ /controler/coolify_token  → SSM SecureString"
  echo "  ✅ /controler/auth_user      → SSM SecureString"
  echo "  ✅ /controler/auth_pass      → SSM SecureString"
  exit 0
else
  echo "❌ ALERTA: Possíveis credenciais hardcoded encontradas:"
  echo ""
  echo "$FOUND"
  echo ""
  echo "Corrija antes de fazer commit/push."
  exit 1
fi
