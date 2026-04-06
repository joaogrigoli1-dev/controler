#!/bin/bash
# ═══════════════════════════════════════
#  Controler — Launcher
#  Duplo-clique para abrir o painel
# ═══════════════════════════════════════

PYTHON="/opt/homebrew/bin/python3.12"
DIR="/Users/jhgm/Documents/DEV/controler"
PORT=3001
URL="http://localhost:$PORT"

cd "$DIR"

# Verifica se já está rodando
if lsof -i :$PORT -sTCP:LISTEN -t &>/dev/null; then
  echo "✅  Controler já está rodando em $URL"
  open "$URL"
  exit 0
fi

echo "🎛️  Iniciando Controler..."

# Inicia servidor em background
nohup "$PYTHON" controler.py > /tmp/controler.log 2>&1 &
SERVER_PID=$!

# Aguarda o servidor responder (máx 10s)
echo -n "   Aguardando"
for i in {1..20}; do
  sleep 0.5
  if curl -s "$URL" > /dev/null 2>&1; then
    echo " pronto!"
    break
  fi
  echo -n "."
done

echo ""
echo "🌐  Abrindo $URL"
open "$URL"
