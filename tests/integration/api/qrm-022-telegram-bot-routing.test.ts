import assert from "node:assert/strict";
import test from "node:test";
import { POST as webhookPost } from "../../../app/api/v1/telegram/webhook/route.ts";

const WEBHOOK_SECRET = "webhook-secret";
const USER_ID = "d8d46960-1bc8-437e-a974-df8a3112f1db";

test.beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-bot-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SECRET_KEY = "secret-key";
});

test("telegram webhook routes /start through the default bot dispatcher without creating chats", async () => {
  const calls: Request[] = [];

  mockFetch(calls, [
    [200, [{ update_id: 22334455, status: "processing" }]],
    [200, [{ id: USER_ID }]],
    [
      200,
      [
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
      ]
    ],
    [200, { ok: true, result: { message_id: 9001 } }],
    [200, null]
  ]);

  const response = await webhookPost(jsonRequest(startUpdate()));
  const telegramPayload = JSON.parse(await calls[3]?.text()) as Record<string, unknown>;
  const receiptPatch = JSON.parse(await calls[4]?.text()) as Record<string, unknown>;
  const paths = calls.map((call) => new URL(call.url).pathname);

  assert.equal(response.status, 200);
  assert.deepEqual(paths, [
    "/rest/v1/telegram_update_receipts",
    "/rest/v1/app_users",
    "/rest/v1/advisors",
    "/bot123456:telegram-bot-token/sendMessage",
    "/rest/v1/telegram_update_receipts"
  ]);
  assert.match(String(telegramPayload.text), /Ask Quorum in this chat\./);
  assert.match(String(telegramPayload.text), /To start a new chat, send \/all or an advisor command\./);
  assert.match(String(telegramPayload.text), /Available advisors:\n\/marcus_aurelius - Marcus Aurelius/);
  assert.doesNotMatch(String(telegramPayload.text), /\/ask/);
  assert.equal(receiptPatch.status, "processed");
  assert.equal(receiptPatch.processed_chat_id, null);
  assert.equal(receiptPatch.processed_turn_id, null);
});

test("telegram webhook treats /ask as unsupported legacy behavior without creating chats", async () => {
  const calls: Request[] = [];

  mockFetch(calls, [
    [200, [{ update_id: 22334455, status: "processing" }]],
    [200, [{ id: USER_ID }]],
    [204, null]
  ]);

  const response = await webhookPost(jsonRequest(commandUpdate("/ask@quorum_bot Marcus Aurelius")));
  const receiptPatch = JSON.parse(await calls[2]?.text()) as Record<string, unknown>;
  const paths = calls.map((call) => new URL(call.url).pathname);

  assert.equal(response.status, 200);
  assert.deepEqual(paths, [
    "/rest/v1/telegram_update_receipts",
    "/rest/v1/app_users",
    "/rest/v1/telegram_update_receipts"
  ]);
  assert.equal(receiptPatch.status, "processed");
  assert.equal(receiptPatch.processed_chat_id, null);
  assert.equal(receiptPatch.processed_turn_id, null);
});

test("telegram webhook routes /all question through advisor selection and persists basis", async () => {
  const calls: Request[] = [];

  process.env.OPENAI_API_KEY = "openai-key";
  mockAllQuestionFetch(calls);

  const response = await webhookPost(jsonRequest(commandUpdate("/all How should I choose?")));
  const selectionCall = calls.find((call) =>
    new URL(call.url).pathname.endsWith("/rest/v1/rpc/quorum_select_advisors_for_question")
  );
  const chatAdvisorCall = calls.find(
    (call) => new URL(call.url).pathname === "/rest/v1/chat_advisors" && call.method === "POST"
  );
  const telegramCalls = calls.filter(
    (call) => new URL(call.url).pathname === "/bot123456:telegram-bot-token/sendMessage"
  );
  const finalCall = calls.at(-1);

  assert.equal(response.status, 200);
  assert.ok(selectionCall);
  assert.ok(chatAdvisorCall);
  assert.ok(finalCall);

  const selectionBody = JSON.parse(await selectionCall.text()) as Record<string, unknown>;
  const chatAdvisorBody = JSON.parse(await chatAdvisorCall.text()) as Array<Record<string, unknown>>;
  const receiptPatch = JSON.parse(await finalCall.text()) as Record<string, unknown>;

  assert.equal(selectionBody.p_limit, 5);
  assert.equal(selectionBody.p_min_score, 0.3);
  assert.deepEqual(chatAdvisorBody, [
    {
      chat_id: "multi-chat",
      advisor_id: "00000000-0000-4000-8000-000000000010",
      selection_rank: 1,
      specialist_fit_score: 0.81,
      selection_basis: {
        topicTagScore: 0.81,
        dossierThemeScore: 0.4,
        sourceCoverageScore: 0.7,
        matchedTopicTagKeys: ["judgment"],
        matchedFragmentIds: ["00000000-0000-4000-8000-000000000020"]
      }
    },
    {
      chat_id: "multi-chat",
      advisor_id: "00000000-0000-4000-8000-000000000011",
      selection_rank: 2,
      specialist_fit_score: 0.79,
      selection_basis: {
        topicTagScore: 0.79,
        dossierThemeScore: 0.3,
        sourceCoverageScore: 0.6,
        matchedTopicTagKeys: ["focus"],
        matchedFragmentIds: ["00000000-0000-4000-8000-000000000021"]
      }
    }
  ]);
  assert.equal(telegramCalls.length, 2);
  assert.deepEqual(
    await Promise.all(telegramCalls.map(async (call) => JSON.parse(await call.text()))),
    [
      {
        chat_id: 987654321,
        text: "Data Advisor: Use judgment.",
        entities: [{ type: "bold", offset: 0, length: "Data Advisor:".length }],
        link_preview_options: { is_disabled: true }
      },
      {
        chat_id: 987654321,
        text: "Focus Advisor: Use judgment.",
        entities: [{ type: "bold", offset: 0, length: "Focus Advisor:".length }],
        link_preview_options: { is_disabled: true }
      }
    ]
  );
  assert.equal(receiptPatch.status, "processed");
  assert.equal(receiptPatch.processed_chat_id, "multi-chat");
  assert.equal(receiptPatch.processed_turn_id, "turn-1");
});

function jsonRequest(body: unknown): Request {
  return new Request("http://app.test/api/v1/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET
    },
    body: JSON.stringify(body)
  });
}

function startUpdate(): Record<string, unknown> {
  return commandUpdate("/start@quorum_bot");
}

function commandUpdate(text: string): Record<string, unknown> {
  return {
    update_id: 22334455,
    message: {
      message_id: 77,
      date: 1777286400,
      chat: {
        id: 987654321,
        type: "private"
      },
      from: {
        id: 123456789,
        is_bot: false,
        first_name: "Rustam",
        username: "rustam",
        language_code: "en",
        is_premium: false
      },
      text,
      entities: [
        {
          type: "bot_command",
          offset: 0,
          length: text.split(/\s/, 1)[0]?.length ?? text.length
        }
      ]
    }
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

    if (body === null) {
      return new Response(null, { status });
    }

    return Response.json(body, { status });
  };
}

function mockAllQuestionFetch(calls: Request[]): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    calls.push(request);

    if (url.pathname === "/rest/v1/telegram_update_receipts" && request.method === "POST") {
      return Response.json([{ update_id: 22334455, status: "processing" }]);
    }

    if (url.pathname === "/rest/v1/app_users" && request.method === "POST") {
      return Response.json([{ id: USER_ID }]);
    }

    if (url.pathname === "/rest/v1/chats" && request.method === "POST") {
      return Response.json([{ id: "multi-chat" }], { status: 201 });
    }

    if (url.pathname === "/rest/v1/telegram_chat_states" && request.method === "POST") {
      return new Response(null, { status: 200 });
    }

    if (url.pathname === "/rest/v1/chat_messages" && request.method === "POST") {
      const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;

      return Response.json([
        {
          id: body.role === "assistant" ? "assistant-message-1" : "user-message-1",
          turn_id: body.role === "assistant" ? body.turn_id : "turn-1",
          role: body.role,
          advisor_id: body.advisor_id ?? null,
          body_text: body.body_text,
          locale: body.locale,
          created_at: "2026-05-07T00:00:00.000Z"
        }
      ]);
    }

    if (url.pathname === "/rest/v1/chats" && request.method === "PATCH") {
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/v1/embeddings" && request.method === "POST") {
      return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    }

    if (
      url.pathname === "/rest/v1/rpc/quorum_select_advisors_for_question" &&
      request.method === "POST"
    ) {
      return Response.json([
        {
          advisor_id: "00000000-0000-4000-8000-000000000010",
          display_name: "Data Advisor",
          display_name_key: "data advisor",
          specialist_fit_score: "0.81",
          topic_tag_score: "0.81",
          dossier_theme_score: "0.40",
          source_coverage_score: "0.70",
          matched_topic_tag_keys: ["judgment"],
          matched_fragment_ids: ["00000000-0000-4000-8000-000000000020"]
        },
        {
          advisor_id: "00000000-0000-4000-8000-000000000011",
          display_name: "Focus Advisor",
          display_name_key: "focus advisor",
          specialist_fit_score: "0.79",
          topic_tag_score: "0.79",
          dossier_theme_score: "0.30",
          source_coverage_score: "0.60",
          matched_topic_tag_keys: ["focus"],
          matched_fragment_ids: ["00000000-0000-4000-8000-000000000021"]
        }
      ]);
    }

    if (url.pathname === "/rest/v1/chat_advisors" && request.method === "POST") {
      return new Response(null, { status: 201 });
    }

    if (url.pathname === "/rest/v1/chat_messages" && request.method === "GET") {
      return Response.json([]);
    }

    if (url.pathname === "/rest/v1/advisor_dossiers" && request.method === "GET") {
      return Response.json([
        {
          id: "dossier-1",
          version: 1,
          payload: {
            tone: { voice: "plain", cadence: "direct", do: [], avoid: [] },
            red_lines: [],
            core_ideas: [{ statement: "Use judgment." }],
            argument_patterns: [],
            secondary_context_notes: []
          }
        }
      ]);
    }

    if (url.pathname === "/rest/v1/rpc/quorum_match_corpus_fragments" && request.method === "POST") {
      return Response.json([
        {
          corpus_fragment_id: "00000000-0000-4000-8000-000000000020",
          fragment_index: 1,
          original_text: "approved source text",
          retrieval_text_en: "approved source text",
          original_language_code: "en",
          source_key: "source",
          document_title: "Source",
          similarity_score: "0.7"
        }
      ]);
    }

    if (url.pathname === "/v1/responses" && request.method === "POST") {
      const body = JSON.parse(await request.clone().text()) as { instructions?: string };
      const displayName = body.instructions?.includes("Focus Advisor")
        ? "Focus Advisor"
        : "Data Advisor";

      return Response.json({
        output: [{ content: [{ type: "output_text", text: `${displayName}: Use judgment.` }] }]
      });
    }

    if (url.pathname === "/rest/v1/chat_message_groundings" && request.method === "POST") {
      return new Response(null, { status: 201 });
    }

    if (url.pathname === "/bot123456:telegram-bot-token/sendMessage" && request.method === "POST") {
      return Response.json({ ok: true, result: { message_id: 9100 } });
    }

    if (url.pathname === "/rest/v1/chat_messages" && request.method === "PATCH") {
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/rest/v1/telegram_update_receipts" && request.method === "PATCH") {
      return new Response(null, { status: 204 });
    }

    return Response.json({ error: "unexpected fetch", url: request.url }, { status: 500 });
  };
}
