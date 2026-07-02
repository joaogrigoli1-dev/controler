# ops/ — scripts operacionais do SRV1

Criados durante o incidente de **2026-06-15** (CPU/RAM a 100% no SRV1).

## Incidente — resumo

- **Sintoma:** CPU subindo em reta por ~10h até travar em 100%; RAM e disco
  explodindo na última hora (RAM → 15,7/16GB; um arquivo de log **deletado mas
  aberto** chegou a ~91GB e foi liberado só no reboot). SSH, Coolify API e Docker
  ficaram inacessíveis (box sem escalonar comandos).
- **Falso alarme descartado:** `(s-server)` a 98% era `redis-server`/`next-server`
  (substring), não miner. Sem persistência maliciosa; `/tmp`,`/dev/shm`,cron limpos.
- **Causa raiz provável:** um **container que vaza memória** agressivamente e
  escreve log sem limite. Após o 1º reboot ele voltou via `restart: always` e
  re-saturou em ~22 min (RAM 0,5GB → 12,9GB).
- **Agravante de boot:** os 41 containers com `restart: always` sobem **todos
  juntos** → manada de `runc` em I/O wait → load chegou a 211.

## Arquivos

| Arquivo | Função | Destino no servidor |
|---|---|---|
| `leak-capture.sh` | Monitor leve contínuo; dump detalhado (top RSS + `docker stats`) sob pressão de RAM/load. Auto-limita o log a 50MB. | `/opt/scripts/` |
| `leak-capture.service` | Serviço systemd permanente do monitor (Nice/idle/CPUQuota 10%). | `/etc/systemd/system/` |
| `staggered-docker-start.sh` | Sobe containers escalonados no boot (infra primeiro, apps 1 a 1). | `/opt/scripts/` |
| `staggered-docker-start.service` | Oneshot systemd que roda o stagger no boot. | `/etc/systemd/system/` |
| `reharden-restart-policy.sh` | Reaplica `unless-stopped` na infra e `on-failure:5` nos apps (Coolify reseta para `always` a cada deploy). | `/opt/scripts/` |

## Instalação

```bash
# scripts
install -m755 leak-capture.sh staggered-docker-start.sh reharden-restart-policy.sh /opt/scripts/
# units
install -m644 leak-capture.service staggered-docker-start.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now leak-capture.service
systemctl enable staggered-docker-start.service   # roda no proximo boot
# para o stagger ter efeito, tirar os apps do auto-start em massa:
/opt/scripts/reharden-restart-policy.sh
```

## Para achar o container vazador

Depois de instalado, `leak-capture` registra em `/var/log/leak-capture.log`.
Quando a RAM passar de 80%, o dump mostra qual `docker stats` está crescendo.
Esse é o container a corrigir (provável memory leak na app — investigar `docker logs`).

## Pendências

- [ ] Identificar e corrigir o container que vaza memória (causa raiz).
- [ ] Confirmar `reharden` + stagger num reboot controlado.
- [ ] Avaliar hook pós-deploy no Coolify para rodar `reharden-restart-policy.sh`.
