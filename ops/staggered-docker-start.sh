#!/usr/bin/env bash
# staggered-docker-start.sh — subida escalonada dos containers no boot para
# evitar o "thundering herd" de runc (dezenas de containers iniciando juntos
# saturam o I/O de disco -> load explode). Já instalado em /opt/scripts/ no SRV1.
# Infra (bancos/proxy) primeiro, depois apps um a um com delay. Idempotente.
set -u
LOG=/var/log/staggered-docker-start.log
DELAY="${STAGGER_DELAY:-8}"      # segundos entre apps
INFRA_DELAY="${INFRA_DELAY:-5}"  # segundos entre itens de infra
exec >>"$LOG" 2>&1
echo "==== $(date -Is) staggered start INICIO ===="

for i in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  echo "aguardando docker ($i)"; sleep 2
done

INFRA_RE='postgres|postgresql|mysql|mariadb|redis|valkey|mongo|clickhouse|rabbitmq|traefik|coolify-proxy|coolify-realtime|coolify-db|coolify-redis'
mapfile -t ALL < <(docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}')

start_one() {
  local id="$1" name="$2" st
  st=$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)
  [ "$st" = "true" ] && { echo "pula (ja rodando): $name"; return; }
  echo "subindo: $name"
  docker start "$id" >/dev/null 2>&1 && echo "  ok: $name" || echo "  FALHOU: $name"
}

echo "--- tier 1: infra ---"
for line in "${ALL[@]}"; do
  IFS=$'\t' read -r id name image <<<"$line"
  echo "$image $name" | grep -qiE "$INFRA_RE" && { start_one "$id" "$name"; sleep "$INFRA_DELAY"; }
done

echo "--- tier 2: apps ---"
for line in "${ALL[@]}"; do
  IFS=$'\t' read -r id name image <<<"$line"
  echo "$image $name" | grep -qiE "$INFRA_RE" && continue
  start_one "$id" "$name"; sleep "$DELAY"
done

echo "==== $(date -Is) staggered start FIM ===="
