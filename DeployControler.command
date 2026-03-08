#!/bin/bash
# DeployControler.command — Clique duplo para fazer deploy do Controler
# Executa: git push + cria/configura app no Coolify + deploy

cd "$(dirname "$0")"

echo ""
echo "=================================================="
echo "  Controler — Deploy para Produção (controler.net.br)"
echo "=================================================="
echo ""

/opt/homebrew/bin/python3.12 devops/deploy_controler.py

echo ""
echo "Pressione ENTER para fechar..."
read
