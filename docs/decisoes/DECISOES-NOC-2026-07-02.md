# Decisões — Auditoria de Implementação NOC — 2026-07-02

> Registro das 7 decisões tomadas na auditoria de implementação do NOC (plano fases 0-6).
> Status possíveis: **Executado** (feito em código/host) | **Documentado-pendente** (registrado aqui; ação operacional a fazer).

## Decisão 1 — AlertRules: avaliador de `condition` + `silencedUntil`

**Status:** EXECUTADO

**Racional:** As regras de alerta existiam no banco mas a `condition` não era efetivamente
avaliada, e o campo `silencedUntil` era ignorado — alertas silenciados continuavam disparando.

**O que foi feito:** Implementado o avaliador de `condition` das AlertRules e o motor de
alertas passou a honrar `silencedUntil` (regra silenciada não notifica até expirar o prazo).

## Decisão 2 — Ordem de trabalho: corrigir tudo, validar, um commit + deploy ao final

**Status:** EXECUTADO

**Racional:** Evitar sequência de deploys parciais em produção durante a auditoria. Um único
ciclo — corrigir todos os achados, validar (typecheck + testes), commit único e deploy ao
final — reduz janelas de risco e facilita rollback (um único ponto de reversão).

## Decisão 3 — Porta SSH 22: não fechar por aqui

**Status:** DOCUMENTADO-PENDENTE (ops)

**Racional:** O código já resolve a porta SSH via SSM (`/shared/srv1/port` = **47391**) com
fallback para 22. Fechar a porta 22 às cegas tem **risco de lockout** se algum coletor,
script ou integração ainda depender do fallback.

**Ação de firewall a fazer no reharden:**
1. Manter a 47391 aberta (porta oficial).
2. Avaliar fechar a 22 **somente após confirmar** que toda a coleta usa a porta do SSM
   (nenhum acesso chegando na 22 por período de observação).
3. Nunca fechar a 22 sem sessão de contingência aberta e snapshot/console alternativo à mão.

## Decisão 4 — `staggered-containers.service` failed: verificado no host

**Status:** VERIFICADO — nenhuma ação necessária

**Racional:** Na descoberta da manhã de 2026-07-02 três units apareciam `failed`
(`redis-server`, `ssh-emergency`, `staggered-containers`), abrindo o risco de reabrir
o incidente de sobrecarga no próximo boot.

**O que foi verificado (via SSH, mesma tarde):** o SRV1 sofreu um reboot controlado às
**2026-07-02 21:16** e, neste boot, **todas as units subiram limpas** — `systemctl
--failed` retorna **vazio**. `staggered-containers.service` rodou com sucesso
(`active (exited)`, status 0/SUCCESS) e o `redis-server.service` está `running`. A
mitigação de start escalonado, portanto, **funcionou neste boot**. Como não havia nada
em estado `failed`, **nenhuma alteração foi feita no host** (evitou-se mexer em systemd
de produção sem necessidade). Os scripts de `ops/` (staggered/leak-capture/reharden) já
estão instalados em `/opt/scripts/` e as units correspondentes `enabled`.

**Pendência de ops (não urgente):** confirmar num próximo reboot controlado que o
`reharden-restart-policy.sh` mantém as políticas (o Coolify reseta `restart: always` a
cada deploy).

## Decisão 5 — Apps Coolify offline (passaro-professor, manalista, apptecph-web)

**Status:** EXECUTADO (parcial)

**Racional:** Três apps offline geravam ruído contínuo de alertas, mas reativá-los é decisão
de negócio do dono (podem estar aposentados de fato).

**O que foi feito:** Apps **NÃO reativados**. Alertas suprimidos via ack-list
(env `NOC_COOLIFY_ACK_OFFLINE_UUIDS`) para parar o ruído; o estado offline continua
registrado/visível no NOC.

**AÇÃO PENDENTE (dono):** reativar ou aposentar formalmente cada um dos três apps.

## Decisão 6 — ollama exposto em `*:11434` + fqdn do controler = `*.sslip.io`

**Status:** DOCUMENTADO-PENDENTE

**Racional:** Dois achados de exposição/configuração: (a) ollama ouvindo em `*:11434` no
host (exposto); (b) fqdn do app controler no Coolify apontando para domínio `*.sslip.io`
em vez do domínio oficial. Não executado autonomamente por serem mudanças em serviço/rota
**vivos** (risco de indisponibilidade).

**Recomendações:**
1. Restringir a porta 11434 no firewall Hostinger ao uso local (não expor à internet).
2. Ajustar o domínio do controler no Coolify para `noc.controler.net.br`.

## Decisão 7 — Tabela `projects` × projetos Coolify divergentes

**Status:** DOCUMENTADO

**Racional:** A tabela `projects` do NOC diverge da lista real de projetos do Coolify.
Reconciliação automática traria complexidade e risco de quebrar FKs sem ganho real.

**Decisão:** Manter `projects` como **tabela de referência** (âncora de FK de
`project_apis`); o NOC lê o **estado real** via Coolify API ao vivo. **Sem reconciliação
automática** entre as duas fontes.

---

## Resumo

| # | Tema | Status |
|---|------|--------|
| 1 | AlertRules: avaliador de condition + silencedUntil | Executado |
| 2 | Ordem: corrigir tudo → validar → 1 commit + deploy | Executado |
| 3 | Porta SSH 22 (fechar só no reharden, com cautela) | Documentado-pendente (ops) |
| 4 | Units verificadas no host — zero failed após reboot 21:16; staggered OK | Verificado (sem ação) |
| 5 | Apps offline ack via NOC_COOLIFY_ACK_OFFLINE_UUIDS | Executado parcial (pendência do dono) |
| 6 | ollama 11434 no firewall + fqdn Coolify → noc.controler.net.br | Documentado-pendente |
| 7 | projects = referência; estado real via Coolify API | Documentado |
