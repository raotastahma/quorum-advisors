import assert from "node:assert/strict";
import test from "node:test";
import { GET as advisorGet } from "../../../app/api/v1/advisors/[slug]/route.ts";
import { POST as telegramSessionPost } from "../../../app/api/v1/auth/telegram/session/route.ts";
import { GET as bootstrapGet } from "../../../app/api/v1/bootstrap/route.ts";
import {
  GET as listMessagesGet,
  POST as postMessagePost
} from "../../../app/api/v1/chats/[chatId]/messages/route.ts";
import { POST as createChatPost } from "../../../app/api/v1/chats/route.ts";
import { POST as webhookPost } from "../../../app/api/v1/telegram/webhook/route.ts";

const WEBHOOK_SECRET = "webhook-secret";
const CHAT_ID = "2c0b96f0-b44b-4ec8-b8a5-c4e830a0e290";

test.beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-bot-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SECRET_KEY = "secret-key";
});

test("explicit Mini App and browser API non-contracts return unsupported without side effects", async () => {
  const calls: Request[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);

    return Response.json({ error: "unexpected side effect", url: request.url }, { status: 500 });
  };

  const responses = await Promise.all([
    telegramSessionPost(jsonRequest("http://app.test/api/v1/auth/telegram/session")),
    bootstrapGet(new Request("http://app.test/api/v1/bootstrap")),
    advisorGet(new Request("http://app.test/api/v1/advisors/marcus-aurelius"), {
      params: { slug: "marcus-aurelius" }
    }),
    createChatPost(jsonRequest("http://app.test/api/v1/chats")),
    listMessagesGet(new Request(`http://app.test/api/v1/chats/${CHAT_ID}/messages`), {
      params: { chatId: CHAT_ID }
    }),
    postMessagePost(jsonRequest(`http://app.test/api/v1/chats/${CHAT_ID}/messages`), {
      params: { chatId: CHAT_ID }
    })
  ]);

  for (const response of responses) {
    const body = await response.json();

    assert.equal(response.status, 410);
    assert.equal(body.error.code, "UNSUPPORTED_RELEASE_CONTRACT");
    assert.match(body.error.message, /unsupported in the Telegram bot-only release/);
    assert.equal(response.headers.get("x-request-id")?.length, 36);
  }

  assert.equal(calls.length, 0);
});

test("Telegram webhook remains the supported next-release API surface", async () => {
  const calls: Request[] = [];
  mockFetch(calls, [
    [200, [{ update_id: 123456789, status: "processing" }]],
    [204, null]
  ]);

  const response = await webhookPost(
    new Request("http://app.test/api/v1/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": WEBHOOK_SECRET
      },
      body: JSON.stringify({ update_id: 123456789 })
    })
  );
  const body = await response.json();
  const receiptPatch = JSON.parse(await calls[1]?.text()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]?.url ?? "").pathname, "/rest/v1/telegram_update_receipts");
  assert.equal(receiptPatch.status, "ignored");
  assert.equal(receiptPatch.error_code, "UNSUPPORTED_UPDATE");
});

function jsonRequest(url: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "tma auth_date=1&hash=bad"
    },
    body: JSON.stringify({})
  });
}

function mockFetch(calls: Request[], responses: Array<[number, unknown]>): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const next = responses.shift();

    calls.push(request);

    if (!next) {
      return Response.json({ error: "unexpected fetch", url: request.url }, { status: 500 });
    }

    const [status, body] = next;

    if (status === 204) {
      return new Response(null, { status });
    }

    return Response.json(body, { status });
  };
}
