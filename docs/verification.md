# Verification record

## Baseline

The original local application was inspected without modification. Its normal Node test command passed 89 tests. A non-incremental TypeScript check passed. The original production corpus was not included in this source package.

## Package changes

- Preserved every application route and server-library module.
- Retained the original TypeScript suite. Two assertions tied to historical production advisor workspaces were adapted to an original fictional workspace; no tests were disabled.
- Added five retrieval/tone tests and a network guard for unmocked fetch calls.
- Replaced the historical corpus seed migration with a documented empty migration. Kept schema history and application functions, then added explicit backend-only API privileges.
- Added an original local SQL seed and a disposable database verification script.
- Omitted production operational scripts, private corpora, generated source seeds and historical source-specific database acceptance checks. They require data deliberately absent from this public package.

## Reproducible checks

Observed on 2026-11-25 with Node.js 25.9.0:

| Check | Result |
|---|---|
| Normal application tests | 94 passed, none skipped |
| TypeScript | Passed |
| Mocked release-contract E2E | 4 passed |
| Offline retrieval and tone | Learning and rest questions select different original evidence |
| Next.js production build | Passed |
| Local production HTTP smoke | Home/health 200; unsupported browser API 410; unauthorized webhook 401 |
| Disposable database | All migrations and original seed applied; selection, retrieval, backend chat finalization/groundings and privilege assertions passed |
| Public npm audit | 0 reported vulnerabilities after dependency remediation |

The source lock initially produced six affected-package findings. The candidate was updated to compatible Next.js 16.4.6 and patched transitive versions, then the normal checks were rerun. No exploit reproduction was performed. An audit result is time-bound and does not prove the absence of unknown vulnerabilities.

```sh
npm test
npm run typecheck
npm run test:e2e
npm run demo
npm run build
sh scripts/verify-db.sh
```

The Node `test:e2e` script is a mocked application-release contract test. It does not operate a real Telegram client. The database script uses original local data with actual pgvector retrieval; it has no network or persistent storage.

The demo validates orchestration, evidence selection, tone, advisor isolation and failure when relevant evidence is missing. Its deterministic vectors are not a model benchmark. Live Telegram delivery, OpenAI quality, hosted Supabase integration and production readiness require separate verification.
