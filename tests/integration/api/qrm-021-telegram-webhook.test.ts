import assert from "node:assert/strict";
import test from "node:test";
import { POST as webhookPost } from "../../../app/api/v1/telegram/webhook/route.ts";
import { handleTelegramWebhook } from "../../../lib/server/telegram/webhook.ts";

const WEBHOOK_SECRET = "webhook-secret";
const USER_ID = "d8d46960-1bc8-437e-a974-df8a3112f1db";

test.beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-bot-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SECRET_KEY = "secret-key";
});

test("POST /api/v1/telegram/webhook rejects invalid secrets before side effects", async () => {
  const calls: Request[] = [];
  mockFetch(calls, []);

  const response = await webhookPost(jsonRequest({ secret: "wrong-secret", body: privateTextUpdate() }));
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHORIZED");
  assert.equal(calls.length, 0);
});

test("POST /api/v1/telegram/webhook rejects invalid JSON before persistence", async () => {
  const calls: Request[] = [];
  mockFetch(calls, []);

  const response = await webhookPost(
    new Request("http://app.test/api/v1/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": WEBHOOK_SECRET
      },
      body: "{"
    })
  );
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(calls.length, 0);
});

test("POST /api/v1/telegram/webhook rejects updates without update_id", async () => {
  const calls: Request[] = [];
  mockFetch(calls, []);

  const response = await webhookPost(jsonRequest({ body: { message: {} } }));
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(calls.length, 0);
});

test("POST /api/v1/telegram/webhook ignores duplicate updates without side effects", async () => {
  const calls: Request[] = [];
  mockFetch(calls, [
    [409, { code: "23505" }],
    [200, [receipt("processed")]]
  ]);

  const response = await webhookPost(jsonRequest({ body: privateTextUpdate() }));
  const body = await response.json();
  const receiptLookupUrl = new URL(calls[1]?.url ?? "");

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(receiptLookupUrl.pathname, "/rest/v1/telegram_update_receipts");
  assert.equal(receiptLookupUrl.searchParams.get("update_id"), "eq.123456789");
});

test("POST /api/v1/telegram/webhook returns 503 when no receipt can be persisted or found", async () => {
  const calls: Request[] = [];
  mockFetch(calls, [
    [500, { error: "receipt insert failed" }],
    [200, []]
  ]);

  const response = await webhookPost(jsonRequest({ body: privateTextUpdate() }));
  const body = await response.json();
  const receiptLookupUrl = new URL(calls[1]?.url ?? "");

  assert.equal(response.status, 503);
  assert.equal(body.error.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(calls.length, 2);
  assert.equal(receiptLookupUrl.pathname, "/rest/v1/telegram_update_receipts");
  assert.equal(receiptLookupUrl.searchParams.get("update_id"), "eq.123456789");
});

test("POST /api/v1/telegram/webhook acknowledges terminal duplicate receipts without side effects", async () => {
  for (const status of ["processed", "ignored", "failed"] as const) {
    const calls: Request[] = [];
    const dispatched: unknown[] = [];
    mockFetch(calls, [
      [409, { code: "23505" }],
      [200, [receipt(status)]]
    ]);

    const response = await handleTelegramWebhook(jsonRequest({ body: privateTextUpdate() }), {
      dispatcher: {
        async dispatch(_config, input) {
          dispatched.push(input);

          return {
            chatId: null,
            turnId: null
          };
        }
      }
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(dispatched.length, 0);
  }
});

test("POST /api/v1/telegram/webhook acknowledges non-stale processing duplicates without side effects", async () => {
  const calls: Request[] = [];
  const dispatched: unknown[] = [];
  mockFetch(calls, [
    [409, { code: "23505" }],
    [200, [receipt("processing", new Date().toISOString())]]
  ]);

  const response = await handleTelegramWebhook(jsonRequest({ body: privateTextUpdate() }), {
    dispatcher: {
      async dispatch(_config, input) {
        dispatched.push(input);

        return {
          chatId: null,
          turnId: null
        };
      }
    }
  });
  const receiptLookupUrl = new URL(calls[1]?.url ?? "");

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(dispatched.length, 0);
  assert.equal(receiptLookupUrl.pathname, "/rest/v1/telegram_update_receipts");
  assert.equal(receiptLookupUrl.searchParams.get("update_id"), "eq.123456789");
});

test("POST /api/v1/telegram/webhook drains stale processing duplicate receipts", async () => {
  const calls: Request[] = [];
  const staleReceivedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  mockFetch(calls, [
    [409, { code: "23505" }],
    [200, [receipt("processing", staleReceivedAt)]],
    [204, null]
  ]);

  const response = await webhookPost(jsonRequest({ body: privateTextUpdate() }));
  const receiptPatch = JSON.parse(await calls[2]?.text()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.method, "PATCH");
  assert.equal(receiptPatch.status, "failed");
  assert.equal(receiptPatch.error_code, "STALE_PROCESSING_DRAINED");
  assert.equal(typeof receiptPatch.processed_at, "string");
});

test("POST /api/v1/telegram/webhook marks authenticated unsupported updates ignored", async () => {
  const calls: Request[] = [];
  mockFetch(calls, [
    [200, [receipt("processing")]],
    [204, null]
  ]);

  const response = await webhookPost(jsonRequest({ body: { update_id: 123456789 } }));
  const receiptPatch = JSON.parse(await calls[1]?.text()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.method, "PATCH");
  assert.equal(receiptPatch.status, "ignored");
  assert.equal(receiptPatch.error_code, "UNSUPPORTED_UPDATE");
  assert.equal(typeof receiptPatch.processed_at, "string");
});

test("POST /api/v1/telegram/webhook finalizes user upsert failures after receipt persistence", async () => {
  const calls: Request[] = [];
  mockFetch(calls, [
    [200, [receipt("processing")]],
    [500, { error: "user upsert failed" }],
    [204, null]
  ]);

  const response = await webhookPost(jsonRequest({ body: privateTextUpdate() }));
  const receiptPatch = JSON.parse(await calls[2]?.text()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(receiptPatch.status, "failed");
  assert.equal(receiptPatch.error_code, "DOWNSTREAM_PROCESSING_FAILED");
  assert.equal(typeof receiptPatch.processed_at, "string");
});

test("POST /api/v1/telegram/webhook finalizes dispatcher failures after receipt persistence", async () => {
  const calls: Request[] = [];
  mockFetch(calls, [
    [200, [receipt("processing")]],
    [200, [{ id: USER_ID }]],
    [204, null]
  ]);

  const response = await handleTelegramWebhook(jsonRequest({ body: privateTextUpdate() }), {
    dispatcher: {
      async dispatch() {
        throw new Error("dispatcher failed");
      }
    }
  });
  const receiptPatch = JSON.parse(await calls[2]?.text()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(receiptPatch.status, "failed");
  assert.equal(receiptPatch.user_id, USER_ID);
  assert.equal(receiptPatch.error_code, "DOWNSTREAM_PROCESSING_FAILED");
  assert.equal(typeof receiptPatch.processed_at, "string");
});

test("POST /api/v1/telegram/webhook upserts users and dispatches supported private text", async () => {
  const calls: Request[] = [];
  const dispatched: unknown[] = [];
  mockFetch(calls, [
    [200, [receipt("processing")]],
    [200, [{ id: USER_ID }]],
    [204, null]
  ]);

  const response = await handleTelegramWebhook(jsonRequest({ body: privateTextUpdate() }), {
    dispatcher: {
      async dispatch(_config, input) {
        dispatched.push(input);

        return {
          chatId: null,
          turnId: null
        };
      }
    }
  });
  const userUpsertUrl = new URL(calls[1]?.url ?? "");
  const userUpsert = JSON.parse(await calls[1]?.text()) as Record<string, unknown>;
  const receiptPatch = JSON.parse(await calls[2]?.text()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(dispatched.length, 1);
  assert.equal(userUpsertUrl.pathname, "/rest/v1/app_users");
  assert.equal(userUpsertUrl.searchParams.get("on_conflict"), "telegram_user_id");
  assert.equal(userUpsert.telegram_user_id, 123456789);
  assert.equal(userUpsert.first_name, "Rustam");
  assert.equal(receiptPatch.status, "processed");
  assert.equal(receiptPatch.user_id, USER_ID);
  assert.equal(typeof receiptPatch.processed_at, "string");
});

function jsonRequest(input: { body: unknown; secret?: string }): Request {
  return new Request("http://app.test/api/v1/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": input.secret ?? WEBHOOK_SECRET
    },
    body: JSON.stringify(input.body)
  });
}

function privateTextUpdate(): Record<string, unknown> {
  return {
    update_id: 123456789,
    message: {
      message_id: 55,
      date: 1777286400,
      chat: {
        id: 987654321,
        type: "private"
      },
      from: {
        id: 123456789,
        is_bot: false,
        first_name: "Rustam",
        last_name: null,
        username: "rustam",
        language_code: "en",
        is_premium: false
      },
      text: "/ask any How should I think about ambition?",
      entities: [
        {
          type: "bot_command",
          offset: 0,
          length: 4
        }
      ]
    }
  };
}

function receipt(status: "processing" | "processed" | "ignored" | "failed", receivedAt?: string) {
  return {
    update_id: 123456789,
    status,
    received_at: receivedAt ?? new Date().toISOString()
  };
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
