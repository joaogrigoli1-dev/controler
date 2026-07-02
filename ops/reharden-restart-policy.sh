#!/usr/bin/env bash
# reharden-restart-policy.sh — reaplica a política de restart dos containers
# para evitar o "thundering herd" de runc no boot.
#
# Infra (bancos/proxy) -> unless-stopped  (sobem rápido e primeiro)
# Apps                 -> on-failure:5    (NÃO sobem em massa no boot;
#                                          ainda recuperam de crash em runtime)
#
# Necessário porque o Coolify reaplica `restart: always` a cada redeploy.
# Rodar após deploys (hook pós-deploy) ou via cron. É idempotente.
set -u

INFRA_RE='postgres|postgresql|mysql|mariadb|redis|valkey|mongo|clickhouse|rabbitmq|traefik|coolify-proxy|coolify-realtime|coolify-db|coolify-redis'
BACKUP=/var/log/restart-policy-backup-$(date +%Y%m%d-%H%M%S).txt

echo "Backup das políticas atuais em: $BACKUP"
docker ps -a --format '{{.Names}}' | while read -r n; do
  pol=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}' "$n" 2>/dev/null)
  echo "$n $pol" >> "$BACKUP"
done

docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}' | while IFS=$'\t' read -r id name image; do
  if echo "$image $name" | grep -qiE "$INFRA_RE"; then
    docker update --restart unless-stopped "$id" >/dev/null 2>&1 \
      && echo "infra  unless-stopped : $name"
  else
    docker update --restart on-failure:5 "$id" >/dev/null 2>&1 \
      && echo "app    on-failure:5   : $name"
  fi
done

echo "Concluído. Restauração possível a partir de $BACKUP"
