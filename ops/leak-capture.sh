#!/usr/bin/env bash
# leak-capture.sh — monitor leve e contínuo de CPU/RAM para o SRV1.
# Grava snapshots compactos a cada INTERVAL; sob pressão (RAM/LOAD), faz dump
# detalhado (top RSS + docker stats) para identificar o container/processo vazador.
# IMPORTANTE: auto-limita o tamanho do log para NUNCA virar o problema
# (referência: incidente do log deletado de 91GB em 2026-06-15).
set -u

LOG=/var/log/leak-capture.log
MAXBYTES=$((50 * 1024 * 1024))  # teto de 50MB para o log
MEM_THRESHOLD=80                # % de RAM usada que dispara dump detalhado
LOAD_THRESHOLD=20               # load 1min que dispara dump detalhado
INTERVAL=60                     # segundos entre amostras

trim_log() {
  local sz
  sz=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  if [ "$sz" -gt "$MAXBYTES" ]; then
    tail -c $((MAXBYTES / 2)) "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
    echo "$(date -Is) [log truncado para caber em ${MAXBYTES} bytes]" >> "$LOG"
  fi
}

echo "==== $(date -Is) leak-capture iniciado (interval=${INTERVAL}s) ====" >> "$LOG"

while true; do
  ts=$(date -Is)
  read -r l1 l5 l15 _ < /proc/loadavg
  memtot=$(awk '/MemTotal/{print $2}' /proc/meminfo)
  memav=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  memused_pct=$(( (memtot - memav) * 100 / memtot ))

  # snapshot compacto sempre
  top3=$(ps -eo rss,comm --sort=-rss --no-headers 2>/dev/null | head -3 \
          | awk '{printf "%s:%dMB ", $2, $1/1024}')
  echo "$ts load=$l1 mem=${memused_pct}% top:[$top3]" >> "$LOG"

  # dump detalhado sob pressão
  l1int=${l1%.*}
  if [ "$memused_pct" -ge "$MEM_THRESHOLD" ] || [ "${l1int:-0}" -ge "$LOAD_THRESHOLD" ]; then
    {
      echo "---- DUMP $ts (mem=${memused_pct}% load=$l1) ----"
      echo "[top RSS host]"
      ps -eo pid,rss,%cpu,comm --sort=-rss 2>/dev/null | head -12
      echo "[docker stats]"
      timeout 20 docker stats --no-stream \
        --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' 2>/dev/null | head -50
      echo "----------------------------------------------"
    } >> "$LOG"
  fi

  trim_log
  sleep "$INTERVAL"
done
