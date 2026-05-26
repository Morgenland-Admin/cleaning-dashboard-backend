# Cleaning Dashboard — Backend

Multi-tenant backend for Cleanilo, Hamburg Teppichreinigung, and Teppichreinigen Lassen. Built with Fastify, Drizzle ORM (Postgres), and Better Auth.

## Requirements

- Node.js >= 20
- pnpm >= 10 (`corepack enable` will provision the pinned version)
- PostgreSQL 14+
- (Optional) Docker + Docker Compose

## Setup

```bash
pnpm install
cp .env.example .env
# edit .env with your values
pnpm run db:migrate
```

## Development

```bash
pnpm dev
```

Server runs at `http://localhost:8000` by default.

## Build & Run

```bash
pnpm build
pnpm start
```

`start` runs migrations, then boots the compiled server from `dist/`.

## Scripts

| Script              | What it does                                  |
| ------------------- | --------------------------------------------- |
| `dev`               | Start dev server with hot reload (tsx watch)  |
| `build`             | Compile TypeScript to `dist/`                 |
| `start`             | Run migrations + start compiled server        |
| `typecheck`         | Type-check without emitting                   |
| `lint` / `lint:fix` | Run ESLint (auto-fix with `:fix`)             |
| `format`            | Format with Prettier                          |
| `format:check`      | Verify formatting without writing             |
| `check`             | Lint + format check + typecheck (CI-friendly) |
| `db:generate`       | Generate a Drizzle migration                  |
| `db:migrate`        | Apply pending migrations                      |
| `db:push`           | Push schema directly (dev only)               |
| `db:studio`         | Open Drizzle Studio                           |
| `db:seed`           | Seed the database                             |

## Tooling

- **ESLint** (flat config, type-checked rules) — see [`eslint.config.js`](eslint.config.js)
- **Prettier** — see [`.prettierrc.json`](.prettierrc.json)
- **Husky** — pre-commit runs `lint-staged` + `typecheck`; commit-msg runs commitlint
- **commitlint** — Conventional Commits (`feat:`, `fix:`, `chore:`, …)

## Environment

See [`.env.example`](.env.example) for required variables: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, AWS S3 credentials, and Stripe keys.

## Docker

```bash
docker compose up --build
```

The compose file provisions Postgres and the API together for local testing.
