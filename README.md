# Quorum Advisors

I built Quorum to learn retrieval-augmented generation: preparing source material, working with embeddings, designing prompts and evaluating grounded advisor replies. The application combines a Telegram bot, a Next.js API, a PostgreSQL/pgvector retrieval layer and OpenAI adapters.

This is a complete application-source package with an original fictional advisor fixture. Historical source texts, third-party corpora, production seeds, private operational records and deployment credentials are excluded.

## Run the offline example

Requires Node.js 24.3 or later and npm.

```sh
npm ci
npm run demo
npm test
npm run typecheck
npm run test:e2e
npm run build
```

The demo uses the application's `RagService`, its repository/model interfaces and its tone rules. It retrieves original learning notes and applies a greeting from the advisor dossier. Change the question to inspect a different retrieval result:

```sh
npm run demo -- "Should I rest and pause after a focused session?"
```

The offline model adapter uses deterministic topic-count vectors and returns selected source text. It makes no network requests and needs no credentials. It demonstrates orchestration and grounding behavior; it does not measure semantic embedding quality or language-model performance.

## Application flow

```text
Telegram webhook -> receipt deduplication -> command dispatcher
  -> advisor selection -> chat repository -> RagService
  -> approved dossier + retrieved fragments -> model adapter
  -> tone rules -> ordered Telegram replies + persisted groundings
```

- Single-advisor and multi-advisor conversations, with advisor-isolated history.
- Database-driven advisor commands and a selection cap of five advisors.
- Approved-corpus retrieval, language selection, prompt assembly and tone directives.
- Telegram update receipts, retry/idempotency handling and sanitized API failures.
- Workspace validation, source normalization/chunking and launch-readiness helpers.
- Schema migrations for corpus provenance, review gates, chat state and selection scores.

The supported live surface is Telegram bot chat. Browser chat, the Mini App, payments and synthesis are not part of this release. The Next.js home page explains that boundary.

## Code map

| Path | Responsibility |
|---|---|
| `app/api/v1/telegram/webhook/` | Supported webhook entry point |
| `lib/server/bot/` | Commands, chat selection and ordered replies |
| `lib/server/rag/` | Retrieval orchestration, language and tone |
| `lib/server/model/` | OpenAI embeddings and Responses API adapter |
| `lib/server/chats/` | Persistence contracts and Supabase repository |
| `lib/server/advisors/` | Workspace and source-processing logic |
| `supabase/migrations/` | Application schema and backend-only access rules |
| `advisors/demo-mentor/` | Original fictional workspace |
| `demo/` | Read-only in-memory adapters |
| `tests/` | Mocked application checks and isolated database smoke test |

## Optional database verification

`sh scripts/verify-db.sh` applies every migration and the original seed, then checks advisor selection, vector retrieval and access privileges in a disposable PostgreSQL container. It uses Docker Compose, a cached Supabase PostgreSQL image and tmpfs storage. The container has no network and exposes no ports. It is removed when the script finishes. On a Colima installation, select its default profile with `DOCKER_CONTEXT=colima`.

The image is configured with `pull_policy: never`; obtain the exact image named in `tests/database/compose.yaml` separately if it is not cached. This check does not start a hosted Supabase service or call Telegram/OpenAI. The fictional seed's readiness timestamp is only test data.

## Live integration

Copy `.env.example` to `.env.local` and configure your own Telegram, Supabase and OpenAI services. Apply the schema as the database owner. Use the server-side service role only in backend code. The included `demo.sql` is for a disposable local database, not a production launch approval.

A real advisor needs redistribution-cleared source material, a validated workspace, actual embeddings and evaluation before launch. Registering a Telegram webhook or deploying a service is an external action; neither is performed by the demo or tests. Live service integration and production readiness are not claimed by this package.

See [verification](docs/verification.md), [security boundaries](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
