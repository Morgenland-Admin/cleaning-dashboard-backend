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

| Script              | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `dev`               | Start dev server with hot reload (tsx watch)   |
| `build`             | Compile TypeScript to `dist/`                  |
| `start`             | Run migrations + start compiled server         |
| `typecheck`         | Type-check without emitting                    |
| `lint` / `lint:fix` | Run ESLint (auto-fix with `:fix`)              |
| `format`            | Format with Prettier                           |
| `format:check`      | Verify formatting without writing              |
| `test`              | Run unit tests (`node:test` via tsx)           |
| `check`             | Lint + format + typecheck + test (CI-friendly) |
| `db:generate`       | Generate a Drizzle migration                   |
| `db:migrate`        | Apply pending migrations                       |
| `db:push`           | Push schema directly (dev only)                |
| `db:studio`         | Open Drizzle Studio                            |
| `db:seed:local`     | Seed local dev data (refuses non-local DB)     |
| `db:seed:prod`      | Minimal prod seed (admin + n8n, env passwords) |

## Tooling

- **ESLint** (flat config, type-checked rules) — see [`eslint.config.js`](eslint.config.js)
- **Prettier** — see [`.prettierrc.json`](.prettierrc.json)
- **Husky** — pre-commit runs `lint-staged` + `typecheck`; commit-msg runs commitlint
- **commitlint** — Conventional Commits (`feat:`, `fix:`, `chore:`, …)

## Environment

See [`.env.example`](.env.example) for required variables: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, AWS S3 credentials, and Stripe keys.

## Marketplace (Stripe Connect)

Partner-fulfilled orders use **Stripe Connect (Express)** with **separate transfers**:

1. Partner calls `POST /partner/partners/connect/onboard` → returns a Stripe
   AccountLink for KYC/bank onboarding. `GET /partner/partners/connect/status`
   re-syncs `chargesEnabled` / `payoutsEnabled`.
2. Admin assigns an order: `POST /admin/orders/:id/assign { partnerId }` →
   computes the commission split (`partners.commission_rate`, default 12%).
3. Admin triggers payout: `POST /admin/orders/:id/payout` → creates a transfer
   funded by the original charge (`source_transaction`), so it never draws on
   platform float. Idempotent.
4. Partner sees only their assigned orders (`/partner/orders`) with the
   customer email + internal/Stripe fields redacted, and can advance the
   fulfilment status (`picked_up → … → delivered`).

**Before this works in production you must:** enable Connect on the Stripe
dashboard, add the connected-account + transfer webhook events
(`account.updated`, `transfer.reversed`) to the same webhook endpoint, and
test payouts end-to-end in Stripe **test mode** with a real test transfer.

## API surface for n8n workflows

All admin endpoints require `Authorization: Bearer <token>` (n8n robot user) +
`X-Company-Slug`. Storefront endpoints need only `X-Company-Slug`.

| Domain              | Endpoints                                                                                                                                                     | Powers                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Reviews             | `POST /storefront/reviews` · `GET /admin/reviews` · `POST /admin/reviews/:id/{respond,flag}` · `PATCH /admin/reviews/:id`                                     | ALL_15, ALL_16                 |
| Subscriptions       | `GET/POST /admin/subscriptions` · `GET /admin/subscriptions/:id` · `POST /admin/subscriptions/:id/{pause,resume,cancel}`                                      | ALL_89                         |
| Invoices            | `GET/POST /admin/invoices` (`?overdue=true`) · `PATCH /admin/invoices/:id` · `POST /admin/invoices/:id/{send,mark-paid,dunning}`                              | ALL_12, ALL_13                 |
| City status         | `GET/POST /admin/city-status` · `PATCH /admin/city-status/:id` · `POST /admin/city-status/:id/recompute`                                                      | ALL_24                         |
| Customers / loyalty | `GET /admin/customers` (`?tier=`) · `PATCH /admin/customers/:id` · `POST /admin/customers/:id/recompute-tier` (auto-maintained on paid order)                 | ALL_79, ALL_20                 |
| Partner tier/score  | `PATCH /admin/partners/:id { tier, score, monthlyFeeCents }`                                                                                                  | ALL_17, ALL_90                 |
| Order edits         | `POST /admin/orders/:id/upsell` · `POST /admin/orders/:id/adjust`                                                                                             | ALL_100, ALL_99                |
| Marketplace         | `POST /admin/orders/:id/{assign,unassign,payout}` · `POST /partner/partners/connect/onboard` · `GET /partner/partners/connect/status` · `GET /partner/orders` | ALL_08, ALL_11, ALL_22, ALL_80 |
| Price adjustments   | `GET/POST /admin/price-adjustments` (record-only — never changes live quotes)                                                                                 | ALL_88                         |

## Operational notes / scaling

The rate-limiter (`@fastify/rate-limit`), Better Auth's login throttle, and the
chat pub/sub hub (`src/modules/chat/hub.ts`) are all **in-memory**. They are
correct for a **single backend instance**. Before running more than one replica
behind a load balancer you must either enable **sticky sessions** (for chat
WebSockets) or move these to a shared **Redis** store, otherwise:

- auth brute-force limits loosen ~N× (per-instance counters), and
- chat events only reach clients connected to the same instance.

Several cross-tenant reads (`/admin/orders/all`, refund/transfer lookup,
`/storefront/q/:token`) fan out one query per company — fine at three brands,
revisit if the tenant count grows large.

## Error tracking

Set `SENTRY_DSN` and `pnpm add @sentry/node` to forward 5xx/webhook errors to
Sentry. Without the package or DSN it degrades to a no-op (see
[`src/lib/observability.ts`](src/lib/observability.ts)).

## Docker

```bash
docker compose up --build
```

The compose file provisions Postgres and the API together for local testing.
