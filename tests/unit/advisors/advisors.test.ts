import assert from "node:assert/strict";
import test from "node:test";
import type { ServerConfig } from "../../../lib/server/config.ts";
import {
  getLaunchEnabledAdvisorByTelegramCommand,
  listLaunchEnabledAdvisors
} from "../../../lib/server/advisors/advisors.ts";

const CONFIG: ServerConfig = {
  telegramBotToken: "123456:telegram-bot-token",
  telegramWebhookSecret: "secret",
  supabaseUrl: "http://supabase.test",
  supabaseSecretKey: "service-role"
};

test("lists only final launch-enabled advisors ordered by display name", async () => {
  const calls: Request[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);

    calls.push(request);

    return Response.json([
      {
        id: "00000000-0000-4000-8000-000000000001",
        slug: "marcus-aurelius",
        telegram_command: "marcus_aurelius",
        display_name: "Marcus Aurelius",
        display_name_key: "marcus aurelius",
        short_bio: "Roman emperor",
        era_label: "Classical antiquity",
        domain_label: "Stoic philosophy",
        supported_locales: ["en", "ru"],
        is_launch_enabled: true,
        readiness_status: "advisor_ready"
      }
    ]);
  };

  const advisors = await listLaunchEnabledAdvisors(CONFIG);
  const url = new URL(calls[0]?.url ?? "");

  assert.equal(url.pathname, "/rest/v1/advisors");
  assert.equal(url.searchParams.get("persona_status"), "eq.active");
  assert.equal(url.searchParams.get("readiness_status"), "eq.advisor_ready");
  assert.equal(url.searchParams.get("is_launch_enabled"), "eq.true");
  assert.equal(url.searchParams.get("benchmark_passed_at"), "not.is.null");
  assert.equal(url.searchParams.get("order"), "display_name.asc");
  assert.match(url.searchParams.get("select") ?? "", /telegram_command/);
  assert.deepEqual(advisors.map((advisor) => advisor.telegramCommand), ["marcus_aurelius"]);
  assert.deepEqual(advisors.map((advisor) => advisor.displayNameKey), ["marcus aurelius"]);
});

test("resolves one launch-enabled advisor by telegram command", async () => {
  const calls: Request[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);

    calls.push(request);

    return Response.json([
      {
        id: "00000000-0000-4000-8000-000000000002",
        slug: "paul-graham",
        telegram_command: "paul_graham",
        display_name: "Paul Graham",
        display_name_key: "paul graham",
        short_bio: "Essayist and investor",
        era_label: "Modern era",
        domain_label: "Startups",
        supported_locales: ["en"],
        is_launch_enabled: true,
        readiness_status: "advisor_ready"
      }
    ]);
  };

  const advisor = await getLaunchEnabledAdvisorByTelegramCommand(CONFIG, "paul_graham");
  const url = new URL(calls[0]?.url ?? "");

  assert.equal(url.pathname, "/rest/v1/advisors");
  assert.equal(url.searchParams.get("telegram_command"), "eq.paul_graham");
  assert.equal(url.searchParams.get("persona_status"), "eq.active");
  assert.equal(url.searchParams.get("readiness_status"), "eq.advisor_ready");
  assert.equal(url.searchParams.get("is_launch_enabled"), "eq.true");
  assert.equal(url.searchParams.get("benchmark_passed_at"), "not.is.null");
  assert.equal(url.searchParams.get("limit"), "1");
  assert.equal(advisor?.telegramCommand, "paul_graham");
  assert.equal(advisor?.displayName, "Paul Graham");
});

test("returns null when no launch-enabled advisor matches the telegram command", async () => {
  globalThis.fetch = async () => Response.json([]);

  const advisor = await getLaunchEnabledAdvisorByTelegramCommand(CONFIG, "marcus-aurelius");

  assert.equal(advisor, null);
});
