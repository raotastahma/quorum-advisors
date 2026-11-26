# Verification record

## Product documentation refresh, 27 November 2026

The hosted product and this public package are different source snapshots. The hosted application adds advisor notes, subscription settings, scheduled delivery and a generic advisor-release schema. Those additions are not copied into this public package.

Read-only hosted checks on 27 November found 13 launch-eligible advisors and 13 distinct current tone payloads with nonempty voice and cadence guidance. The active production deployment was ready. The database had the latest delivery-time migration and one active scheduler running every five minutes. A scheduled delivery had a Telegram confirmation. These observations establish the inspected product state; they do not measure delivery to every subscriber or overall voice quality.

Fresh local checks for this documentation refresh passed 111 public application tests, TypeScript, four mocked release checks, the offline demo and a production build. The built application returned home and health HTTP 200 and unsupported browser bootstrap HTTP 410 on localhost. The isolated private source passed 150 application tests, TypeScript and four mocked release checks. Local documentation links resolved and the patch passed whitespace checks. No live messages or scheduled jobs were triggered by these local checks. The dated results below retain their original scope.

The documented disposable database check also passed all 23 public migrations, the original demo seed and the smoke script's 19 assertions. A separate local database applied all 33 private migrations and passed the committed transactional thought-subscription fixture. That fixture covers scheduling, rotation, retries, opt-out and custom delivery times. It rolled back completely; no scheduler job or HTTP request was created. Both test containers used Colima's default profile, no network or exposed ports, and temporary database storage, and both were removed afterward. These checks do not exercise actual scheduled delivery or provider calls.

## Database access for new functions

Migration `0023` removes PostgreSQL's default public execution grant for functions created by the migration owner. The disposable database test creates a fresh RPC, checks both browser roles' effective permissions, grants the backend access, calls the function as the backend and rolls back the fixture.

## Original baseline

The original private application at the recorded pre-portfolio source commit passed 89 Node tests and its TypeScript check in an isolated clone. The initial public source package passed 94 tests, its mocked release checks, demo, typecheck, build, clean reinstall and disposable database checks. Those initial results preceded the Marcus dialogue-opening change. The private production corpus is excluded from this public package.

## Final Marcus dialogue-opening change

Marcus's greeting is tied to a persisted dialogue-opening claim, independent of hello/bye keywords. `Salve` is used for English and `Сальве` for Russian; the Marcus policy never appends `Vale`. A bare Marcus command consumes the opening before its question prompt so the following answer does not repeat it. Other advisors retain their existing curator tone behavior, including the fictional Demo Mentor's Welcome rule.

The new database migration is limited to the persisted opening marker and backend-only RPC. There is no global dossier-write ban, no new persona gate and no rewrite of stored dossier history. The repository carries the stored advisor slug into the dossier record; model context removes only the known retired Marcus instruction entries. Other tone guidance, other personas' rules, user words and natural model output remain intact.

Application routes remain unchanged. Six server-library files were intentionally changed for lifecycle handling, legacy Marcus context and formatting. Current Marcus workspace/seed inputs and benchmark tooling were corrected in the isolated private lane; they are not corpus artifacts bundled in this public package. Historical generated evidence was preserved and documented as superseded rather than regenerated.

## Reproducible checks

Observed on 2026-11-25 with Node.js 25.9.0:

| Check | Result |
|---|---|
| Final public application tests | 111 passed, none skipped |
| Final isolated private application tests | 106 passed, none skipped |
| Private offline Python benchmark regressions | 8 passed; no model or database calls |
| TypeScript | Both lanes passed |
| Mocked release-contract E2E | 4 passed |
| Original offline retrieval/tone demo | Preserved Demo Mentor Welcome behavior and advisor-scoped retrieval |
| Next.js production build | Both lanes passed |
| Disposable database | All migrations/seed and retrieval/chat/privilege checks passed; opening claims covered same-turn retries, bare command then answer, new chats, advisor isolation and resumed history beyond 1,000 turns |
| Exact missing-RPC compatibility | Missing opener RPC skipped only for PGRST202/42883 naming that function; unrelated upstream errors remain errors |
| Failed Telegram delivery retry | Stored answer reused without regeneration, a second claim or another appended greeting |
| Public npm audit | Previously 0; dependencies unchanged by this source-only change |
| Final Gitleaks source snapshot and complete candidate history | 0 findings |
| Fresh isolated clone | Public-registry install with scripts disabled, 111 tests, 4 release checks, demo, typecheck and build passed; tracked tree remained clean |

The initial package's local production HTTP smoke returned home/health 200, unsupported browser API 410 and unauthorized webhook 401. No application route changed in this patch. The Node `test:e2e` command is a mocked release-contract test, not a real Telegram-client test. The disposable database has no network or persistent volume and uses original synthetic fixtures, not production data.

```sh
npm test
npm run typecheck
npm run test:e2e
npm run demo
npm run build
DOCKER_CONTEXT=colima sh scripts/verify-db.sh
```

The offline demo uses deterministic vectors to show how the application selects evidence. The [dialogue-opening notes](marcus-dialogue-opening.md) cover migration order and delivery retries.

## Hosted Telegram check

On 26 November 2026, a real Telegram client opened a new Marcus dialogue in the hosted application. Marcus opened once with `Salve` for the chat's English locale. He answered a Russian question in Russian and responded to a farewell without repeating the greeting or adding `Vale`. Telegram accepted both generated replies. The application recorded four retrieved source fragments for each reply. The public demo uses a fictional corpus so readers can run it locally.
