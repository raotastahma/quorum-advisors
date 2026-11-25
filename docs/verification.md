# Verification record

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
| Final secret scans and clean clone | Pending final source snapshot verification |

The initial package's local production HTTP smoke returned home/health 200, unsupported browser API 410 and unauthorized webhook 401. No application route changed in this patch. The Node `test:e2e` command is a mocked release-contract test, not a real Telegram-client test. The disposable database has no network or persistent volume and uses original synthetic fixtures, not production data.

```sh
npm test
npm run typecheck
npm run test:e2e
npm run demo
npm run build
DOCKER_CONTEXT=colima sh scripts/verify-db.sh
```

The demo's deterministic vectors demonstrate orchestration and evidence selection, not model quality. No live Telegram delivery, model-provider generation, hosted Supabase mutation, launch enablement or production deployment was performed. See [migration order and failure semantics](marcus-dialogue-opening.md), including the at-most-once styling tradeoff for an ambiguous bare-command delivery failure.
