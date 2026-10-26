# Security policy

LA Miner stores personal data of real people — names, CPF numbers, phone
numbers, e-mail and postal addresses of court-case creditors — and runs paid
lookups against a data provider. Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report it privately through GitHub: open the **Security** tab of this
repository and click **Report a vulnerability** (GitHub's *Private
vulnerability reporting*). Only the maintainer sees the report.

Please include:

- the affected file, route or screen;
- steps to reproduce, or a proof of concept against a **local** instance;
- the impact you expect (cross-tenant data exposure, privilege escalation,
  personal data in logs, paid lookups triggered without authorization, denial
  of service…).

You can expect an acknowledgement within a few days. Fixes land in the main
codebase first and reach this repository with the next public snapshot.

## Scope and rules

- **Test only against your own local instance.** Never run scanners or
  exploits against `laminer.com.br`, `app.laminer.com.br` or
  `api.laminer.com.br`: the production database holds personal data of real
  people, and it is not a test environment.
- Run locally with `ENRICHMENT_PROVIDER=fake` and `BILLING_PROVIDER=manual`
  (the defaults in `.env.example`), so nothing reaches the data provider or the
  payment gateway.
- Do not access, modify or keep data that isn't yours.
- In scope: everything in this repository — the NestJS API and worker, the
  authentication flow (JWT, refresh-token rotation, TOTP), tenant isolation
  (`escopoProcessos`, the scope sentinel in `apps/api/src/prisma/`), the
  Next.js app and its Content Security Policy, the SQL migrations and the CI
  workflow.
- Out of scope: the third-party services the app integrates with (the data
  provider, Asaas, Resend, the CNJ's public SISPREQ calculator) and findings
  that require an already compromised server or administrator account.

## Supported versions

Only the latest snapshot on the default branch is supported.
