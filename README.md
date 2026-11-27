# Quorum Advisors

<p align="center">
  <img src="assets/quorum.jpg" alt="Quorum" width="132">
</p>

If you could ask Marcus Aurelius one question, what would it be? Quorum lets you bring that question to an AI advisor inspired by his writings. Explore it with any of 13 advisors, compare their answers, or subscribe to a daily reflection in Telegram.

## Ask your first question

1. [Open Quorum in Telegram](https://t.me/quorum_ai_bot) and press **Start** to see the advisor directory.
2. Choose an advisor, or type `/all` followed by your question. For example, try `/all What should I test before committing to a new product idea?` Quorum selects up to five relevant advisors and gives each a separate reply.
3. For a short reading, send `/thought`. Use `/thought_settings` to choose when and how often notes arrive, change their language, or turn them off.

## Product and advisor styles

Each advisor is an AI interpretation of documented ideas and writings. In a group conversation, each one receives its own conversation history and source passages.

The advisor catalog includes the following perspectives.

| Advisor | Curated perspective and style |
|---|---|
| Marcus Aurelius | Measured Stoic reflection on judgment, duty and the next available action |
| Paul Graham | Plainspoken analysis, concrete distinctions and founder-facing examples |
| Andrej Karpathy | Accessible technical explanations, observable failure modes and diagnostic checks |
| Brené Brown | Warm, candid discussion of vulnerability, trust and clear interpersonal boundaries |
| Charlie Munger | Multidisciplinary reasoning about incentives, judgment and avoidable mistakes |
| Elon Musk | Brief first-principles reasoning about physical and economic constraints |
| Friedrich Nietzsche | Pointed questions and contrasts that examine the values behind a premise |
| Gary Vaynerchuk | Direct, energetic advice about documenting work and taking a specific action |
| Jeff Bezos | Customer outcomes, explicit mechanisms and reversible decisions |
| Nassim Nicholas Taleb | Concrete exposure, nonlinear risk, counterexamples and limits of inference |
| Naval Ravikant | Concise distinctions about leverage, independent judgment and tradeoffs |
| Sam Altman | Ambitious but uncertainty-aware choices about focus, compounding and AI economics |
| Steve Jobs | Consequential choices explained through relevant details and demanding practical criteria |

## How the replies are grounded

Quorum uses retrieval-augmented generation (RAG). It retrieves passages from each advisor’s approved sources using embeddings, then passes those passages, the question and the advisor’s style instructions to a shared model. The service uses a Next.js API, PostgreSQL with pgvector and OpenAI adapters. Selected English and Russian scenarios check source use and tone.

The hosted Telegram service includes the full advisor catalog and scheduled delivery. This repository contains the conversation and retrieval code with an original sample corpus for local development.

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

The supported application surface in this snapshot is Telegram bot chat. Browser chat, the Mini App, payments and synthesis are not part of this release. The Next.js home page explains that boundary.

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

## Marcus dialogue opening

For a database-configured Marcus advisor, the Telegram bot opens a true new dialogue with `Salve` in English or `Сальве` in Russian. The opening is persisted per chat, independent of hello/bye keywords. The following answer does not duplicate a bare-command opening, and the Marcus policy never appends `Vale`. Other advisors retain their existing tone behavior. See [migration order, retry behavior and limitations](docs/marcus-dialogue-opening.md).
