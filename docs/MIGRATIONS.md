# Migrations

> Regra curta: **toda migration deste repositório é SQL escrito à mão.**
> `prisma migrate dev` e `prisma migrate diff` não podem gerar as nossas.

## Por que à mão

O Prisma não enxerga tudo que existe no banco. O que ele não enxerga, ele
apaga — sem aviso, e o teste que quebra depois não fala de migration nenhuma.

Hoje há **duas famílias** de objetos invisíveis para ele:

**1. Os cinco índices trigram (GIN/pg_trgm).** Estão em
`packages/database/prisma/migrations/00000000000001_busca_por_nome/migration.sql`,
e são o que faz a busca por trecho de nome, de CPF e de número de precatório ser
indexada em vez de varrer a tabela inteira. O schema do Prisma não tem sintaxe
para eles. Rodar `prisma migrate diff` gera um script que os DERRUBA, porque para
o Prisma eles simplesmente não existem — e a busca continua respondendo, só que
lendo a tabela toda. O sintoma é lentidão, não erro: ninguém percebe até a base
crescer.

**2. Índices PARCIAIS (`CREATE UNIQUE INDEX ... WHERE ...`).** Mesma cegueira. A
diferença é que aqui o prejuízo não é lentidão, é dado errado: um índice parcial
único é a única defesa que sobra quando a aplicação erra sob concorrência.

## Como escrever uma

1. Altere `packages/database/prisma/schema.prisma`.
2. Crie a pasta `packages/database/prisma/migrations/<AAAAMMDDHHMMSS>_<nome>/` e
   escreva `migration.sql` **você mesmo**, no estilo das existentes (comentário
   no topo dizendo POR QUE, não O QUE).
3. Prefira alterações **aditivas**: coluna nova opcional, tabela nova, índice
   novo. A API e o site sobem em serviços separados na Render, e a janela entre
   os dois deploys precisa continuar de pé — coluna obrigatória nova derruba a
   versão antiga do código que ainda está no ar.
4. `npx prisma generate` para atualizar o client. **Com a API parada**: gerar com
   ela de pé dá `EPERM` no Windows, porque o processo segura o arquivo.
5. Rode a suíte de integração. Ela usa Postgres de verdade.

## O que NUNCA rodar

```
prisma migrate dev
prisma migrate diff
prisma db push
```

Os três partem do princípio de que o schema do Prisma é a verdade completa sobre
o banco. Aqui não é.

## Como saber que um índice invisível sumiu

Não confie em revisão de código para isso — confie em teste. Todo objeto que o
Prisma não enxerga deve ter um teste de integração que **grava direto no banco
esperando a violação**. Se o índice sumir, a suíte fica vermelha no mesmo dia,
em vez de a lentidão (ou o dado duplicado) aparecer meses depois em produção.
