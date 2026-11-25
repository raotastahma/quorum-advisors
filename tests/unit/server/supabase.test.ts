import assert from "node:assert/strict";
import test from "node:test";
import { postgrest, UpstreamUnavailableError } from "../../../lib/server/supabase.ts";

const CONFIG = {
  supabaseUrl: "https://supabase.test",
  supabaseSecretKey: "sb_secret_example",
  telegramBotToken: "telegram-token",
  telegramWebhookSecret: "webhook-secret"
};

test("postgrest sends Supabase secret key only as apikey", async () => {
  const capturedRequests: Request[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedRequests.push(new Request(input, init));

    return Response.json([{ id: "row-id" }]);
  };

  await postgrest<{ id: string }[]>(CONFIG, {
    method: "POST",
    path: "app_users",
    body: { id: "row-id" },
    prefer: "return=representation"
  });

  const [capturedRequest] = capturedRequests;

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.headers.get("apikey"), "sb_secret_example");
  assert.equal(capturedRequest.headers.get("authorization"), null);
  assert.equal(capturedRequest.headers.get("content-type"), "application/json");
  assert.equal(capturedRequest.headers.get("prefer"), "return=representation");
});

test("postgrest accepts successful empty responses", async () => {
  for (const status of [200, 201, 204]) {
    globalThis.fetch = async () => new Response(null, { status });

    const result = await postgrest<undefined>(CONFIG, {
      method: "POST",
      path: "telegram_chat_states",
      body: { telegram_chat_id: 123 }
    });

    assert.equal(result, undefined);
  }
});

test("postgrest parses successful JSON responses", async () => {
  globalThis.fetch = async () =>
    Response.json([{ id: "row-id", display_name: "Marcus Aurelius" }], { status: 200 });

  const result = await postgrest<Array<{ id: string; display_name: string }>>(CONFIG, {
    path: "advisors"
  });

  assert.deepEqual(result, [{ id: "row-id", display_name: "Marcus Aurelius" }]);
});

test("postgrest includes upstream text for non-2xx responses", async () => {
  globalThis.fetch = async () =>
    new Response("column advisors.telegram_command does not exist", { status: 400 });

  await assert.rejects(
    postgrest<unknown>(CONFIG, {
      path: "advisors"
    }),
    (error) =>
      error instanceof UpstreamUnavailableError &&
      error.message === "column advisors.telegram_command does not exist"
  );
});
