# money

Split-aware personal finance tracker (BoB statements, categories, reimbursements).

## Quick start

```bash
bun install
cp .env.example .env.local   # fill DATABASE_URL, AUTH_SECRET, etc.
bun run baseline-migrations  # only if DB was previously created with db:push
bun run db:migrate
BOOTSTRAP_EMAIL=you@example.com BOOTSTRAP_PASSWORD='...' bun run bootstrap-owner
bun run dev
```

Sign in at [http://localhost:3000/login](http://localhost:3000/login).

## Docs for agents & contributors

**[AGENTS.md](./AGENTS.md)** — architecture, auth, migrations, security rules, file map, troubleshooting. Read this before making changes.
