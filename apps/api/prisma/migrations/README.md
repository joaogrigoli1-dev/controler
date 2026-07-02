# Migrations — controler

**`db push` é PROIBIDO em produção.** A partir da Fase 2 o schema evolui por `prisma migrate`.

## Baseline (uma vez, em prod que já rodava `db push`)

A produção já tem o schema aplicado via `db push` e **não** tem a tabela `_prisma_migrations`.
Para adotar migrations sem recriar nada, marque o baseline como já aplicado:

```bash
# 1) O baseline (0_baseline) representa o schema ATUAL — já existe no banco.
# 2) Registra como aplicado SEM executar o SQL:
npx prisma migrate resolve --applied 0_baseline
```

## Fluxo normal (dev → prod)

```bash
# Dev: cria e aplica migration a partir de mudanças no schema.prisma
npx prisma migrate dev --name <descricao>

# Prod (deploy): aplica migrations pendentes, nunca db push
npx prisma migrate deploy
```

> O `Dockerfile`/script de deploy deve chamar `prisma migrate deploy` (não `db push`).
> O baseline `0_baseline/migration.sql` foi gerado com
> `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
