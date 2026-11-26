# Quorum Advisors

I built Quorum to learn retrieval-augmented generation (RAG). Users can ask one advisor a question or compare several perspectives in Telegram. I learned to select sources, retrieve relevant passages with embeddings, shape each advisor's voice and evaluate answers in English and Russian. The application combines a Telegram bot, a Next.js API, PostgreSQL with pgvector and OpenAI adapters.

This repository is a runnable snapshot of the conversation architecture with an original fictional advisor fixture. The hosted product has evolved beyond this snapshot. Historical source texts, third-party corpora, production seeds, private operational records and deployment credentials are excluded.

## Product and advisor styles

Quorum is for people seeking different perspectives on work, decisions, learning and personal questions. Users can choose an advisor or send `/all` to receive up to five separately generated replies selected for specialist fit. Each advisor receives its own conversation history and retrieved evidence. Advisors are AI interpretations of documented ideas, not the real people or their official representatives.

As of 27 November 2026, the [hosted Telegram bot](https://t.me/quorum_ai_bot) has 13 launch-enabled advisors. Their approved dossiers specify different reasoning and writing patterns:

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

Each advisor uses a shared model. Curated source material, retrieved passages and instructions from the advisor's approved dossier shape the answer. I used selected English and Russian scenarios to check whether replies stayed grounded and followed the intended style.

## Advisor notes in Telegram

In Telegram, `/thought` requests a short note from a randomly selected advisor. Scheduled editions rotate among eligible advisors and draw on approved ideas and source passages.

In a private chat, a processed interaction enrolls the reader in a daily note at 09:00 UTC. `/thought_settings` lets readers switch delivery off or on, choose a UTC time and an interval in days, and select English, Russian or their Telegram language. This language choice also applies to `/thought`. The scheduler checks for due notes every five minutes.

On 27 November, the hosted scheduler was active and Telegram had acknowledged a scheduled delivery. The hosted application runs the subscriptions. The example below demonstrates retrieval and dialogue locally with a fictional advisor.

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
