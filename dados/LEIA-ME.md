# dados/

Planilhas de carga do seed. **Nada aqui vai para o git** — o `.gitignore` da raiz
já cobre `*.xlsx`, e é de propósito: a planilha da carteira tem nome e CPF de
milhares de pessoas reais.

O seed procura `carteira.xlsx` nesta pasta. Para usar outro caminho, defina
`SEED_XLSX` no `.env`.

```bash
npm run seed --workspace @miner/database
```
