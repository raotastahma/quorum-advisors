# Security boundaries

The offline demo uses in-memory adapters and original fixtures. The test runner denies unmocked network calls. No credentials, user conversations or production infrastructure configuration are included.

In the live application, Telegram's webhook secret is checked before update processing. Server configuration fails when required values are missing. The OpenAI and Supabase keys stay in server-side adapters. Disabled browser routes do not grant access to bot conversations.

Migration `0021_service_only_api.sql` explicitly removes table access and application-RPC execution from anonymous and browser-authenticated database roles. Existing narrowly granted backend service-role access is preserved. The disposable database check inspects these privileges and verifies backend retrieval.

The source review covered webhook authentication, secret defaults, mocked external boundaries, source/fixture inclusion and database privileges. It was a defensive review, without exploit reproduction. Tests and secret scanners do not establish production security or guarantee that a package contains no unknown vulnerability.

Before a live deployment, configure independent credentials, validate the webhook, set provider budgets and retention rules, review current dependency advisories and complete a real service integration check. Keep the fictional demo seed out of a production launch process. Report suspected issues privately to the repository maintainer rather than posting private inputs or credentials.
