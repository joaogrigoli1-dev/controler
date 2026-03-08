#!/bin/bash
# Controler — Launcher
# Duplo-clique para iniciar o servidor na porta 3001

cd "/Users/jhgm/Documents/DEV/controler"

# Ativa virtualenv se existir
if [ -d ".venv" ]; then
  source .venv/bin/activate
elif [ -d "venv" ]; then
  source venv/bin/activate
fi

echo "🎛️  Iniciando Controler em http://localhost:3001"
echo ""
python3 controler.py
