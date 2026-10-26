# Contributing

Thanks for taking the time to look at LA Miner. Bug reports, test cases and
pull requests are welcome.

The code, comments and UI are in Brazilian Portuguese because the users are
Brazilian law firms. Issues and pull requests can be written in English or
Portuguese.

## Workflow

1. **Fork** the repository and clone your fork.
2. Create a **branch** from `main` with a descriptive name
   (`fix/import-empty-cpf`, `feat/funnel-filter`…).
3. Make the change, with tests (see below).
4. Open a **pull request** against `main` explaining *what* changed and *why*.
   The CI workflow runs on every pull request; it must be green.

Security problems are not reported through issues or pull requests — see
[SECURITY.md](SECURITY.md).

## Setting up

Requirements: Node.js **22.12 or newer** (the version used in CI is in
`.node-version`), PostgreSQL 16 and Redis 7. The `README.md` has the full
walkthrough; the short version:

```bash
npm ci                      # also generates the Prisma client (postinstall)
cp .env.example .env        # fill DATABASE_URL and the two JWT secrets
npm run db:migrate:deploy
```

Keep `ENRICHMENT_PROVIDER=fake` and `BILLING_PROVIDER=manual` (the defaults):
with them nothing leaves your machine — no paid lookup, no real invoice.

## Checks to run before opening a pull request

These are the same steps the CI runs, in the same order:

```bash
npm run typecheck                          # tsc on the API and on the web app
npm test                                   # unit tests: jest (API) + vitest (web)
npm run test:int:preparar -w @miner/api    # (re)creates <db>_test and applies migrations
npm run test:int                           # integration tests, against real PostgreSQL
npm run audit:prod                         # vulnerability gate for production dependencies
npm run build                              # API (nest build) + web (next build)
```

Notes:

- The integration suite **refuses to run** against a database whose name does
  not end in `_test`: it truncates tables between cases. It derives the test
  database from `DATABASE_URL` (`miner` → `miner_test`), or uses
  `DATABASE_URL_TEST` if set. The Postgres user needs `CREATEDB`.
- Do not run `npm run build` while the dev servers are running: `next build`
  and `next dev` share `apps/web/.next`, and `nest build` and
  `nest start --watch` share `apps/api/dist`. To check types without stopping
  anything, use `npm run typecheck`.

## Conventions worth knowing

- **Migrations are hand-written SQL.** Never use `prisma migrate dev`,
  `prisma migrate diff` or `prisma db push`: the schema has trigram (GIN)
  indexes and partial unique indexes that Prisma cannot see, and those commands
  would drop them. See [docs/MIGRATIONS.md](docs/MIGRATIONS.md).
- **Mirrored files.** `timeline-processo.ts` and `colunas-planilha.ts` exist
  both in the API and in `packages/database`; a test compares the copies byte
  by byte. Change both.
- **No real personal data in fixtures.** Use the classic test CPFs already in
  the suite (`529.982.247-25`, `390.533.447-05`, `111.444.777-35`), invented
  names and addresses, and IPs from the documentation ranges (RFC 5737).
- **Comments explain why, not what.** Most modules open with the reasoning
  behind a decision; keep that habit when you change one.
- Never commit `.env`, spreadsheets (`*.xlsx`, `*.csv`) or database dumps —
  they are in `.gitignore` because they carry personal data.

## License

By contributing you agree that your contribution is licensed under the MIT
License of this repository (see [LICENSE](LICENSE)). The brand assets listed
there are not covered by it.
