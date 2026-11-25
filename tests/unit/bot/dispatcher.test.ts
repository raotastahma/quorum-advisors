import assert from "node:assert/strict";
import test from "node:test";
import type { ServerConfig } from "../../../lib/server/config.ts";
import {
  buildStartMessage,
  DefaultBotCommandDispatcher,
  ensureAdvisorPrefix,
  parseTelegramBotCommand,
  sanitizePublicAdvisorReply,
  selectApprovedStartMessageLocale,
  TELEGRAM_SEND_MESSAGE_TEXT_LIMIT,
  truncateTelegramAdvisorReply,
  type StartMessageTemplate
} from "../../../lib/server/bot/dispatcher.ts";
import { buildBoldPrefixEntity } from "../../../lib/server/telegram/client.ts";
import type { TelegramMessage } from "../../../lib/server/telegram/types.ts";

const CONFIG: ServerConfig = {
  telegramBotToken: "123456:telegram-bot-token",
  telegramWebhookSecret: "secret",
  supabaseUrl: "http://supabase.test",
  supabaseSecretKey: "service-role"
};

const MARCUS = launchAdvisor({
  id: "00000000-0000-4000-8000-000000000001",
  telegramCommand: "marcus_aurelius",
  displayName: "Marcus Aurelius",
  displayNameKey: "marcus aurelius"
});
const PAUL = launchAdvisor({
  id: "00000000-0000-4000-8000-000000000002",
  telegramCommand: "paul_graham",
  displayName: "Paul Graham",
  displayNameKey: "paul graham"
});

test("parses bot commands only from bot_command entities at offset zero", () => {
  assert.deepEqual(
    parseTelegramBotCommand(
      telegramMessage({
        text: "/all@quorum_bot   How should I decide?",
        entities: [{ type: "bot_command", offset: 0, length: 15 }]
      })
    ),
    {
      kind: "command",
      name: "all",
      args: "How should I decide?"
    }
  );
  assert.deepEqual(
    parseTelegramBotCommand(
      telegramMessage({
        text: "/marcus_aurelius",
        entities: [{ type: "bot_command", offset: 0, length: 16 }]
      })
    ),
    {
      kind: "command",
      name: "marcus_aurelius",
      args: ""
    }
  );
  assert.deepEqual(parseTelegramBotCommand(telegramMessage({ text: "/start" })), {
    kind: "ordinary_text",
    text: "/start"
  });
  assert.deepEqual(
    parseTelegramBotCommand(
      telegramMessage({
        text: "please /all now",
        entities: [{ type: "bot_command", offset: 7, length: 4 }]
      })
    ),
    {
      kind: "ordinary_text",
      text: "please /all now"
    }
  );
});

test("/start uses approved copy, command lines, locale fallback, and one disclaimer", async () => {
  const sent: Array<{ text: string }> = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({
      list: [MARCUS, PAUL]
    }),
    chatRepository: unusedChatRepository(),
    replyGenerator: unusedReplyGenerator(),
    async telegramSender(_config, input) {
      sent.push({ text: input.text });

      return { messageId: 100 };
    }
  });

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({
      text: "/start@quorum_bot",
      entities: [{ type: "bot_command", offset: 0, length: 17 }],
      languageCode: "pt-BR"
    })
  });

  assert.deepEqual(result, { chatId: null, turnId: null });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, buildStartMessage([MARCUS, PAUL], "pt-BR"));
  assert.match(sent[0]?.text ?? "", /To start a new chat, send \/all or an advisor command\./);
  assert.match(sent[0]?.text ?? "", /\/paul_graham - Paul Graham/);
  assert.doesNotMatch(sent[0]?.text ?? "", /\/ask/);
  assert.equal((sent[0]?.text.match(/Quorum advisors are AI agents/g) ?? []).length, 1);
});

test("/start uses approved Russian copy for Russian Telegram locales", () => {
  const text = buildStartMessage([MARCUS, PAUL], "ru-RU");

  assert.equal(selectApprovedStartMessageLocale("ru-RU"), "ru");
  assert.match(text, /Задайте свой вопрос Quorum в этом чате\./);
  assert.match(text, /Доступные советники:\n\/marcus_aurelius - Marcus Aurelius/);
  assert.match(text, /Спросить всех подходящих советников:\n\/all/);
  assert.match(text, /ДИСКЛЕЙМЕР:\nСоветники Quorum/);
  assert.doesNotMatch(text, /<question>/);
});

test("start message locale selection uses approved non-English templates when supplied", () => {
  const templates = {
    en: ((input) => `en:${input.advisorCommandLines}`) satisfies StartMessageTemplate,
    zz: ((input) => `zz:${input.advisorCommandExamples}`) satisfies StartMessageTemplate
  };

  assert.equal(selectApprovedStartMessageLocale("zz-ZZ", templates), "zz");
  assert.equal(selectApprovedStartMessageLocale("fr", templates), "en");
  assert.equal(buildStartMessage([MARCUS], "zz-ZZ", templates), "zz:/marcus_aurelius <question> - Marcus Aurelius");
});

test("advisor command without inline question creates current single chat and sends bold greeting", async () => {
  const calls: string[] = [];
  const sent: Array<{ text: string; entities: unknown }> = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({
      byCommand: {
        marcus_aurelius: MARCUS
      }
    }),
    chatRepository: {
      ...unusedChatRepository(),
      async createSingleAdvisorChat(_config, input) {
        calls.push(`create-single:${input.advisorId}:${input.telegramChatId}:${input.locale}`);

        return { id: "chat-1" };
      },
      async setCurrentChat(_config, input) {
        calls.push(`current:${input.userId}:${input.chatId}`);
      }
    },
    replyGenerator: unusedReplyGenerator(),
    async telegramSender(_config, input) {
      sent.push({ text: input.text, entities: input.entities });

      return { messageId: 200 };
    }
  });

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({
      text: "/marcus_aurelius@quorum_bot",
      entities: [{ type: "bot_command", offset: 0, length: 27 }]
    })
  });

  assert.deepEqual(result, { chatId: "chat-1", turnId: null });
  assert.deepEqual(calls, [
    `create-single:${MARCUS.id}:987654321:en`,
    "current:user-1:chat-1"
  ]);
  assert.deepEqual(sent, [
    {
      text: "Marcus Aurelius: What would you like to discuss or ask?",
      entities: [buildBoldPrefixEntity("Marcus Aurelius")]
    }
  ]);
});

test("advisor command with inline question stores first turn and sends one answer", async () => {
  const sent: Array<{ text: string; entities: unknown }> = [];
  const updates: number[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({
      byCommand: {
        paul_graham: PAUL
      }
    }),
    chatRepository: {
      ...singleTurnChatRepository({ updates }),
      async createSingleAdvisorChat() {
        return { id: "chat-inline" };
      },
      async setCurrentChat() {}
    },
    replyGenerator: {
      async listMessages() {
        return [];
      },
      async generateReply(_config, input) {
        assert.equal(input.advisorId, PAUL.id);
        assert.equal(input.userBody, "How do I start?");

        return {
          fragments: [fragment("fragment-1")],
          modelName: "test-model",
          replyText: "Start with a concrete user."
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push({ text: input.text, entities: input.entities });

      return { messageId: 777 };
    }
  });

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({
      messageId: 66,
      text: "/paul_graham How do I start?",
      entities: [{ type: "bot_command", offset: 0, length: 12 }]
    })
  });

  assert.equal(result.chatId, "chat-inline");
  assert.equal(result.turnId, "turn-1");
  assert.deepEqual(sent, [
    {
      text: "Paul Graham: Start with a concrete user.",
      entities: [buildBoldPrefixEntity("Paul Graham")]
    }
  ]);
  assert.deepEqual(updates, [777]);
});

test("advisor command repository writes tolerate successful empty response bodies", async () => {
  const calls: Request[] = [];
  const sent: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({
      byCommand: {
        marcus_aurelius: MARCUS
      }
    }),
    replyGenerator: unusedReplyGenerator(),
    async telegramSender(_config, input) {
      sent.push(input.text);

      return { messageId: 200 };
    }
  });

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    calls.push(request);
    if (url.pathname === "/rest/v1/rpc/quorum_claim_marcus_dialogue_opening") return Response.json(false);

    if (url.pathname === "/rest/v1/chats" && request.method === "POST") {
      return Response.json([{ id: "single-empty-writes" }], { status: 201 });
    }

    if (url.pathname === "/rest/v1/chat_advisors" && request.method === "POST") {
      return new Response(null, { status: 201 });
    }

    if (url.pathname === "/rest/v1/telegram_chat_states" && request.method === "POST") {
      return new Response(null, { status: 200 });
    }

    return Response.json({ error: "unexpected fetch", url: request.url }, { status: 500 });
  };

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({
      text: "/marcus_aurelius",
      entities: [{ type: "bot_command", offset: 0, length: 16 }]
    })
  });

  assert.deepEqual(result, { chatId: "single-empty-writes", turnId: null });
  assert.deepEqual(sent, ["Marcus Aurelius: What would you like to discuss or ask?"]);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    [
      "POST /rest/v1/chats",
      "POST /rest/v1/chat_advisors",
      "POST /rest/v1/telegram_chat_states",
      "POST /rest/v1/rpc/quorum_claim_marcus_dialogue_opening"
    ]
  );
});

test("advisor commands resolve only through launch-enabled telegram_command", async () => {
  const calls: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: {
      async listLaunchEnabledAdvisors() {
        return [];
      },
      async getLaunchEnabledAdvisorByTelegramCommand(_config, telegramCommand) {
        calls.push(telegramCommand);

        return telegramCommand === "marcus_aurelius" ? MARCUS : null;
      }
    },
    chatRepository: unusedChatRepository(),
    replyGenerator: unusedReplyGenerator(),
    async telegramSender() {
      throw new Error("unexpected telegramSender call");
    }
  });

  assert.deepEqual(
    await dispatcher.dispatch(CONFIG, {
      userId: "user-1",
      message: telegramMessage({
        text: "/marcus-aurelius How now?",
        entities: [{ type: "bot_command", offset: 0, length: 16 }]
      })
    }),
    { chatId: null, turnId: null }
  );
  assert.deepEqual(calls, ["marcus-aurelius"]);
});

test("/ask is unsupported and does not resolve advisors or create chats", async () => {
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: {
      async listLaunchEnabledAdvisors() {
        throw new Error("unexpected listLaunchEnabledAdvisors call");
      },
      async getLaunchEnabledAdvisorByTelegramCommand() {
        throw new Error("unexpected getLaunchEnabledAdvisorByTelegramCommand call");
      }
    },
    advisorSelector: unusedAdvisorSelector(),
    chatRepository: unusedChatRepository(),
    replyGenerator: unusedReplyGenerator(),
    async telegramSender() {
      throw new Error("unexpected telegramSender call");
    }
  });

  for (const text of ["/ask", "/ask anything", "/ask@quorum_bot Marcus Aurelius"]) {
    const length = text.startsWith("/ask@") ? 15 : 4;

    assert.deepEqual(
      await dispatcher.dispatch(CONFIG, {
        userId: "user-1",
        message: telegramMessage({
          text,
          entities: [{ type: "bot_command", offset: 0, length }]
        })
      }),
      { chatId: null, turnId: null }
    );
  }
});

test("/all without inline question creates current multi chat and sends acknowledgement", async () => {
  const calls: string[] = [];
  const sent: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({}),
    chatRepository: {
      ...unusedChatRepository(),
      async createMultiAdvisorChat(_config, input) {
        calls.push(`create-multi:${input.telegramChatId}:${input.locale}`);

        return { id: "multi-chat" };
      },
      async setCurrentChat(_config, input) {
        calls.push(`current:${input.userId}:${input.chatId}`);
      }
    },
    replyGenerator: unusedReplyGenerator(),
    async telegramSender(_config, input) {
      sent.push(input.text);

      return { messageId: 300 };
    }
  });

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({
      text: "/all",
      entities: [{ type: "bot_command", offset: 0, length: 4 }]
    })
  });

  assert.deepEqual(result, { chatId: "multi-chat", turnId: null });
  assert.deepEqual(calls, ["create-multi:987654321:en", "current:user-1:multi-chat"]);
  assert.deepEqual(sent, ["Chat started. Send your question."]);
});

test("/all with inline question creates multi chat and sends selected advisor answers", async () => {
  const turns: string[] = [];
  const selections: string[] = [];
  const sent: string[] = [];
  const generatedFor: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({}),
    advisorSelector: advisorSelector({ selected: [MARCUS, PAUL] }),
    chatRepository: {
      ...multiTurnChatRepository({ turns, selections }),
      async createMultiAdvisorChat() {
        return { id: "multi-inline" };
      },
      async setCurrentChat() {}
    },
    replyGenerator: {
      async listMessages() {
        return [];
      },
      async generateReply(_config, input) {
        generatedFor.push(`${input.advisorDisplayName}:${input.userBody}`);

        return {
          fragments: [],
          modelName: "test-model",
          replyText: `${input.advisorDisplayName} answers.`
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push(input.text);

      return { messageId: null };
    }
  });

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({
      messageId: 88,
      text: "/all How should I choose?",
      entities: [{ type: "bot_command", offset: 0, length: 4 }]
    })
  });

  assert.deepEqual(result, { chatId: "multi-inline", turnId: "turn-1" });
  assert.deepEqual(turns, ["multi-inline:88:How should I choose?:en"]);
  assert.deepEqual(selections, [
    `multi-inline:1:${MARCUS.id}`,
    `multi-inline:2:${PAUL.id}`
  ]);
  assert.deepEqual(generatedFor, [
    "Marcus Aurelius:How should I choose?",
    "Paul Graham:How should I choose?"
  ]);
  assert.deepEqual(sent, [
    "Marcus Aurelius: Marcus Aurelius answers.",
    "Paul Graham: Paul Graham answers."
  ]);
});

test("multi-advisor generation can complete out of order while Telegram sends stay rank ordered", async () => {
  const generatedFor: string[] = [];
  const insertedFor: string[] = [];
  const sent: Array<{ text: string; entities: unknown }> = [];
  const resolveReply: Record<string, () => void> = {};
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({}),
    advisorSelector: advisorSelector({ selected: [MARCUS, PAUL] }),
    chatRepository: {
      ...multiTurnChatRepository({ turns: [] }),
      async createMultiAdvisorChat() {
        return { id: "multi-inline" };
      },
      async setCurrentChat() {},
      async insertAssistantTurn(
        _config,
        turnInput: { turnId: string; body: string; advisorId: string }
      ) {
        insertedFor.push(turnInput.advisorId);

        return {
          id: `assistant-message-${turnInput.advisorId}`,
          turnId: turnInput.turnId,
          role: "assistant" as const,
          advisorId: turnInput.advisorId,
          body: turnInput.body,
          locale: "en" as const,
          createdAt: "2026-04-27T00:00:01.000Z"
        };
      }
    },
    replyGenerator: {
      async listMessages() {
        return [];
      },
      async generateReply(_config, input) {
        generatedFor.push(input.advisorId);

        await new Promise<void>((resolve) => {
          resolveReply[input.advisorId] = resolve;
        });

        return {
          fragments: [],
          modelName: "test-model",
          replyText: `${input.advisorDisplayName} answers.`
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push({ text: input.text, entities: input.entities });

      return { messageId: null };
    }
  });

  const dispatchPromise = dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({
      messageId: 89,
      text: "/all How should I choose?",
      entities: [{ type: "bot_command", offset: 0, length: 4 }]
    })
  });

  await waitFor(() => generatedFor.length === 2);
  resolveReply[PAUL.id]?.();
  await Promise.resolve();
  resolveReply[MARCUS.id]?.();

  assert.deepEqual(await dispatchPromise, { chatId: "multi-inline", turnId: "turn-1" });
  assert.deepEqual(generatedFor, [MARCUS.id, PAUL.id]);
  assert.deepEqual(insertedFor, [PAUL.id, MARCUS.id]);
  assert.deepEqual(sent, [
    {
      text: "Marcus Aurelius: Marcus Aurelius answers.",
      entities: [buildBoldPrefixEntity("Marcus Aurelius")]
    },
    {
      text: "Paul Graham: Paul Graham answers.",
      entities: [buildBoldPrefixEntity("Paul Graham")]
    }
  ]);
});

test("/all with inline question repository writes tolerate empty bodies and sends advisor answer", async () => {
  const calls: Request[] = [];
  const sent: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({}),
    advisorSelector: advisorSelector({ selected: [MARCUS] }),
    replyGenerator: {
      async listMessages() {
        return [];
      },
      async generateReply(_config, input) {
        assert.equal(input.advisorId, MARCUS.id);
        assert.equal(input.userBody, "How should I choose?");

        return {
          fragments: [],
          modelName: "test-model",
          replyText: "Choose by what is in your control."
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push(input.text);

      return { messageId: 901 };
    }
  });

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    calls.push(request);
    if (url.pathname === "/rest/v1/rpc/quorum_claim_marcus_dialogue_opening") return Response.json(false);

    if (url.pathname === "/rest/v1/chats" && request.method === "POST") {
      return Response.json([{ id: "multi-empty-writes" }], { status: 201 });
    }

    if (url.pathname === "/rest/v1/telegram_chat_states" && request.method === "POST") {
      return new Response(null, { status: 200 });
    }

    if (url.pathname === "/rest/v1/chat_messages" && request.method === "POST") {
      const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;

      return Response.json(
        [
          {
            id: body.role === "assistant" ? "assistant-message-1" : "user-message-1",
            turn_id: body.turn_id,
            role: body.role,
            advisor_id: body.advisor_id,
            body_text: body.body_text,
            locale: body.locale,
            created_at: "2026-04-27T00:00:00.000Z"
          }
        ],
        { status: 201 }
      );
    }

    if (url.pathname === "/rest/v1/chat_messages" && request.method === "GET") {
      return Response.json([]);
    }

    if (url.pathname === "/rest/v1/chats" && request.method === "PATCH") {
      return new Response(null, { status: 201 });
    }

    if (url.pathname === "/rest/v1/chat_advisors" && request.method === "POST") {
      return new Response(null, { status: 200 });
    }

    if (url.pathname === "/rest/v1/chat_messages" && request.method === "PATCH") {
      return new Response(null, { status: 200 });
    }

    return Response.json({ error: "unexpected fetch", url: request.url }, { status: 500 });
  };

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({
      messageId: 88,
      text: "/all How should I choose?",
      entities: [{ type: "bot_command", offset: 0, length: 4 }]
    })
  });
  const userTurn = JSON.parse(await calls[2]?.text()) as Record<string, unknown>;
  const selection = JSON.parse(await calls[4]?.text()) as Array<Record<string, unknown>>;

  assert.equal(result.chatId, "multi-empty-writes");
  assert.ok(result.turnId);
  assert.equal(userTurn.body_text, "How should I choose?");
  assert.deepEqual(selection.map((row) => row.advisor_id), [MARCUS.id]);
  assert.deepEqual(selection.map((row) => row.specialist_fit_score), [0.7]);
  assert.deepEqual(sent, ["Marcus Aurelius: Choose by what is in your control."]);
});

test("ordinary text without current chat creates a multi chat and sends selected advisor answers", async () => {
  const turns: string[] = [];
  const sent: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({}),
    advisorSelector: advisorSelector({ selected: [MARCUS] }),
    chatRepository: {
      ...multiTurnChatRepository({ turns }),
      async getCurrentChat() {
        return null;
      },
      async createMultiAdvisorChat() {
        return { id: "multi-from-text" };
      },
      async setCurrentChat() {}
    },
    replyGenerator: {
      async listMessages() {
        return [];
      },
      async generateReply() {
        return {
          fragments: [],
          modelName: "test-model",
          replyText: "Attend to what is yours."
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push(input.text);

      return { messageId: null };
    }
  });

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({ text: "What should I do with fear?" })
  });

  assert.deepEqual(result, { chatId: "multi-from-text", turnId: "turn-1" });
  assert.deepEqual(turns, ["multi-from-text:55:What should I do with fear?:en"]);
  assert.deepEqual(sent, ["Marcus Aurelius: Attend to what is yours."]);
});

test("ordinary text continues an active current single-advisor chat", async () => {
  const sent: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({}),
    chatRepository: {
      ...singleTurnChatRepository({}),
      async getCurrentChat() {
        return {
          kind: "single_advisor" as const,
          id: "current-chat",
          advisorId: MARCUS.id,
          advisorDisplayName: MARCUS.displayName,
          locale: "en" as const
        };
      }
    },
    replyGenerator: {
      async listMessages() {
        return [];
      },
      async generateReply() {
        return {
          fragments: [],
          modelName: "test-model",
          replyText: "Marcus Aurelius: Attend to what is yours."
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push(input.text);

      return { messageId: null };
    }
  });

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({ text: "What should I do with fear?" })
  });

  assert.deepEqual(result, { chatId: "current-chat", turnId: "turn-1" });
  assert.deepEqual(sent, ["Marcus Aurelius: Attend to what is yours."]);
});

test("ordinary text continues an active current multi-advisor chat with existing selected advisors", async () => {
  const turns: string[] = [];
  const sent: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({}),
    chatRepository: {
      ...multiTurnChatRepository({ turns }),
      async getCurrentChat() {
        return {
          kind: "multi_advisor" as const,
          id: "current-multi",
          locale: "en" as const,
          advisors: [
            {
              advisorId: PAUL.id,
              advisorDisplayName: PAUL.displayName
            }
          ]
        };
      }
    },
    replyGenerator: {
      async listMessages() {
        return [
          {
            id: "other-advisor-message",
            turnId: "previous-turn",
            role: "assistant" as const,
            advisorId: MARCUS.id,
            body: "Marcus Aurelius: Other advisor history.",
            locale: "en" as const,
            createdAt: "2026-04-27T00:00:00.000Z"
          }
        ];
      },
      async generateReply(_config, input) {
        assert.deepEqual(input.conversation, []);

        return {
          fragments: [],
          modelName: "test-model",
          replyText: "Paul Graham: Pick a concrete problem."
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push(input.text);

      return { messageId: null };
    }
  });

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({ text: "Which specialist should answer?" })
  });

  assert.deepEqual(result, { chatId: "current-multi", turnId: "turn-1" });
  assert.deepEqual(turns, ["current-multi:55:Which specialist should answer?:en"]);
  assert.deepEqual(sent, ["Paul Graham: Pick a concrete problem."]);
});

test("duplicate multi-advisor Telegram messages reuse persisted assistant sends", async () => {
  const assistantMessages = new Map<string, { body: string; telegramMessageId: number | null }>();
  const generatedFor: string[] = [];
  const sent: string[] = [];
  const updates: number[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({}),
    chatRepository: {
      ...multiTurnChatRepository({ turns: [] }),
      async getCurrentChat() {
        return {
          kind: "multi_advisor" as const,
          id: "current-multi",
          locale: "en" as const,
          advisors: [
            {
              advisorId: MARCUS.id,
              advisorDisplayName: MARCUS.displayName,
              selectionRank: 1
            }
          ]
        };
      },
      async insertTelegramUserTurn() {
        return {
          id: "user-message-1",
          turnId: "turn-1",
          role: "user" as const,
          body: "How should I act?",
          locale: "en" as const,
          telegramMessageId: 55,
          createdAt: "2026-04-27T00:00:00.000Z"
        };
      },
      async getAssistantTurn(_config, input: { advisorId: string }) {
        const existing = assistantMessages.get(input.advisorId);

        return existing
          ? {
              id: `assistant-message-${input.advisorId}`,
              turnId: "turn-1",
              role: "assistant" as const,
              advisorId: input.advisorId,
              body: existing.body,
              locale: "en" as const,
              telegramMessageId: existing.telegramMessageId,
              createdAt: "2026-04-27T00:00:01.000Z"
            }
          : null;
      },
      async insertAssistantTurn(_config, input: { advisorId: string; body: string }) {
        assistantMessages.set(input.advisorId, {
          body: input.body,
          telegramMessageId: null
        });

        return {
          id: `assistant-message-${input.advisorId}`,
          turnId: "turn-1",
          role: "assistant" as const,
          advisorId: input.advisorId,
          body: input.body,
          locale: "en" as const,
          telegramMessageId: null,
          createdAt: "2026-04-27T00:00:01.000Z"
        };
      },
      async updateAssistantTelegramMessageId(_config, input: { messageId: string; telegramMessageId: number }) {
        updates.push(input.telegramMessageId);
        assistantMessages.set(MARCUS.id, {
          body: assistantMessages.get(MARCUS.id)?.body ?? "",
          telegramMessageId: input.telegramMessageId
        });
      }
    },
    replyGenerator: {
      async listMessages() {
        return [];
      },
      async generateReply(_config, input) {
        generatedFor.push(input.advisorId);

        return {
          fragments: [fragment("fragment-1")],
          modelName: "test-model",
          replyText: "Act from principle."
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push(input.text);

      return { messageId: 700 + sent.length };
    }
  });
  const message = telegramMessage({ text: "How should I act?", messageId: 55 });

  assert.deepEqual(await dispatcher.dispatch(CONFIG, { userId: "user-1", message }), {
    chatId: "current-multi",
    turnId: "turn-1"
  });
  assert.deepEqual(await dispatcher.dispatch(CONFIG, { userId: "user-1", message }), {
    chatId: "current-multi",
    turnId: "turn-1"
  });

  assert.deepEqual(generatedFor, [MARCUS.id]);
  assert.deepEqual(sent, ["Marcus Aurelius: Act from principle."]);
  assert.deepEqual(updates, [701]);
});

test("ordinary text resumes a repository-backed current multi-advisor chat", async () => {
  const calls: Request[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({}),
    advisorSelector: advisorSelector({ selected: [] }),
    replyGenerator: unusedReplyGenerator(),
    async telegramSender() {
      throw new Error("unexpected telegramSender call");
    }
  });

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    calls.push(request);
    if (url.pathname === "/rest/v1/rpc/quorum_claim_marcus_dialogue_opening") return Response.json(false);

    if (url.pathname === "/rest/v1/telegram_chat_states") {
      return Response.json([{ current_chat_id: "current-multi" }]);
    }

    if (url.pathname === "/rest/v1/chats" && request.method === "GET") {
      if (url.searchParams.get("chat_kind") === "eq.single_advisor") {
        return Response.json([]);
      }

      return Response.json([
        {
          id: "current-multi",
          locale: "en",
          status: "active",
          chat_kind: "multi_advisor"
        }
      ]);
    }

    if (url.pathname === "/rest/v1/chat_advisors" && request.method === "GET") {
      return Response.json([]);
    }

    if (url.pathname === "/rest/v1/chat_messages" && request.method === "POST") {
      return Response.json([
        {
          id: "user-message-1",
          turn_id: "turn-1",
          role: "user",
          body_text: "Which specialist should answer?",
          locale: "en",
          created_at: "2026-04-27T00:00:00.000Z"
        }
      ]);
    }

    if (url.pathname === "/rest/v1/chats" && request.method === "PATCH") {
      return new Response(null, { status: 204 });
    }

    return Response.json({ error: "unexpected fetch", url: request.url }, { status: 500 });
  };

  const result = await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({ text: "Which specialist should answer?" })
  });
  const chatLookup = calls.find(
    (call) => new URL(call.url).pathname === "/rest/v1/chats" && call.method === "GET"
  );
  const insertedTurn = JSON.parse(await calls[3]?.text()) as Record<string, unknown>;

  assert.deepEqual(result, { chatId: "current-multi", turnId: "turn-1" });
  assert.ok(chatLookup);
  assert.equal(new URL(chatLookup.url).searchParams.get("chat_kind"), null);
  assert.equal(insertedTurn.chat_id, "current-multi");
  assert.equal(calls.length, 5);
});

test("advisor answer truncation preserves the bold display-name prefix", async () => {
  const sent: Array<{ text: string; entities: unknown }> = [];
  const storedAssistantBodies: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({
      byCommand: {
        paul_graham: PAUL
      }
    }),
    chatRepository: {
      ...singleTurnChatRepository({ storedAssistantBodies }),
      async createSingleAdvisorChat() {
        return { id: "chat-inline" };
      },
      async setCurrentChat() {}
    },
    replyGenerator: {
      async listMessages() {
        return [];
      },
      async generateReply() {
        return {
          fragments: [],
          modelName: "test-model",
          replyText: "x".repeat(TELEGRAM_SEND_MESSAGE_TEXT_LIMIT + 100)
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push({ text: input.text, entities: input.entities });

      return { messageId: null };
    }
  });

  await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({
      text: "/paul_graham How do I stay under Telegram limits?",
      entities: [{ type: "bot_command", offset: 0, length: 12 }]
    })
  });

  const text = sent[0]?.text ?? "";

  assert.equal(text.length, TELEGRAM_SEND_MESSAGE_TEXT_LIMIT);
  assert.equal(storedAssistantBodies[0], text);
  assert.equal(text.startsWith("Paul Graham:"), true);
  assert.deepEqual(sent[0]?.entities, [buildBoldPrefixEntity("Paul Graham")]);
});

test("advisor answers do not expose internal grounding metadata in Telegram messages", async () => {
  const sent: string[] = [];
  const storedAssistantBodies: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({
      byCommand: {
        paul_graham: PAUL
      }
    }),
    chatRepository: {
      ...singleTurnChatRepository({ storedAssistantBodies }),
      async createSingleAdvisorChat() {
        return { id: "chat-inline" };
      },
      async setCurrentChat() {}
    },
    replyGenerator: {
      async listMessages() {
        return [];
      },
      async generateReply() {
        return {
          fragments: [fragment("fragment-1")],
          modelName: "test-model",
          replyText:
            "Start with a concrete user.\nsource_key=pg-greatwork\nhttps://www.paulgraham.com/greatwork.html\nstorage_path=paul-graham/corpus/text/pg-greatwork.txt"
            + "\ntag_key=startup_ideas\nmatchedTopicTagKeys=[startup_ideas]\nspecialistFitScore=0.91\nselection_rank=1"
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push(input.text);

      return { messageId: null };
    }
  });

  await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: telegramMessage({
      text: "/paul_graham How do I start?",
      entities: [{ type: "bot_command", offset: 0, length: 12 }]
    })
  });

  assert.equal(sent[0], "Paul Graham: Start with a concrete user.");
  assert.equal(storedAssistantBodies[0], sent[0]);
});

test("builds UTF-16 bold entity for the display-name prefix", () => {
  assert.deepEqual(buildBoldPrefixEntity("李小龍"), {
    type: "bold",
    offset: 0,
    length: "李小龍:".length
  });
  assert.equal(ensureAdvisorPrefix("Keep going.", "Marcus Aurelius"), "Marcus Aurelius: Keep going.");
  assert.equal(
    truncateTelegramAdvisorReply(`Marcus Aurelius: ${"x".repeat(TELEGRAM_SEND_MESSAGE_TEXT_LIMIT)}`)
      .length,
    TELEGRAM_SEND_MESSAGE_TEXT_LIMIT
  );
  assert.equal(
    sanitizePublicAdvisorReply(
      "provenance_locator: paragraph 2\nhttps://www.paulgraham.com/x.html\nmatchedTopicTagKeys=[startup_ideas]"
        + "\nselection_basis={}\nsourceCoverageScore=0.8"
    ),
    "I cannot expose internal source details."
  );
});

function telegramMessage(
  input: {
    text: string;
    entities?: TelegramMessage["entities"];
    messageId?: number;
    languageCode?: string | null;
  }
): TelegramMessage {
  return {
    message_id: input.messageId ?? 55,
    chat: {
      id: 987654321,
      type: "private"
    },
    from: {
      id: 123456789,
      is_bot: false,
      first_name: "Rustam",
      language_code: input.languageCode ?? "en"
    },
    text: input.text,
    entities: input.entities
  };
}

function launchAdvisor(input: {
  id: string;
  telegramCommand: string;
  displayName: string;
  displayNameKey: string;
}) {
  return {
    id: input.id,
    slug: input.displayNameKey.replaceAll(" ", "-"),
    telegramCommand: input.telegramCommand,
    displayName: input.displayName,
    displayNameKey: input.displayNameKey,
    shortBio: "bio",
    eraLabel: "era",
    domainLabel: "domain",
    supportedLocales: ["en", "ru"],
    isLaunchEnabled: true,
    readinessStatus: "advisor_ready"
  };
}

function advisorDirectory(input: { list?: ReturnType<typeof launchAdvisor>[]; byCommand?: Record<string, ReturnType<typeof launchAdvisor>> }) {
  return {
    async listLaunchEnabledAdvisors() {
      return input.list ?? [];
    },
    async getLaunchEnabledAdvisorByTelegramCommand(_config: ServerConfig, telegramCommand: string) {
      return input.byCommand?.[telegramCommand] ?? null;
    }
  };
}

function advisorSelector(input: { selected: ReturnType<typeof launchAdvisor>[] }) {
  return {
    async selectForQuestion(_config: ServerConfig, selectionInput: { question: string; limit: number }) {
      assert.equal(selectionInput.limit, 5);

      return {
        selectedAdvisors: input.selected.map((advisor, index) => ({
          advisorId: advisor.id,
          displayName: advisor.displayName,
          selectionRank: index + 1,
          specialistFitScore: 0.7,
          selectionBasis: {
            topicTagScore: 0.7,
            dossierThemeScore: 0.2,
            sourceCoverageScore: 0.4,
            matchedTopicTagKeys: [`tag-${index + 1}`],
            matchedFragmentIds: [`fragment-${index + 1}`]
          }
        }))
      };
    }
  };
}

function unusedAdvisorSelector() {
  return {
    async selectForQuestion() {
      throw new Error("unexpected selectForQuestion call");
    }
  };
}

function fragment(id: string) {
  return {
    id,
    fragmentIndex: 1,
    originalText: "source text",
    retrievalTextEn: "source text",
    originalLanguageCode: "en",
    sourceKey: "source",
    documentTitle: "Document",
    similarityScore: 0.9
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("condition was not met");
}

function unusedChatRepository() {
  return {
    async createSingleAdvisorChat(): Promise<{ id: string }> {
      throw new Error("unexpected createSingleAdvisorChat call");
    },
    async createMultiAdvisorChat(): Promise<{ id: string }> {
      throw new Error("unexpected createMultiAdvisorChat call");
    },
    async setMultiAdvisorSelection(): Promise<void> {
      throw new Error("unexpected setMultiAdvisorSelection call");
    },
    async setCurrentChat(): Promise<void> {
      throw new Error("unexpected setCurrentChat call");
    },
    async getCurrentChat(): Promise<null> {
      throw new Error("unexpected getCurrentChat call");
    },
    async insertTelegramUserTurn() {
      throw new Error("unexpected insertTelegramUserTurn call");
    },
    async insertAssistantTurn() {
      throw new Error("unexpected insertAssistantTurn call");
    },
    async getAssistantTurn() {
      throw new Error("unexpected getAssistantTurn call");
    },
    async claimDialogueOpening() { return false; },
    async updateAssistantTelegramMessageId(): Promise<void> {
      throw new Error("unexpected updateAssistantTelegramMessageId call");
    }
  };
}

function unusedReplyGenerator() {
  return {
    async listMessages() {
      throw new Error("unexpected listMessages call");
    },
    async generateReply() {
      throw new Error("unexpected generateReply call");
    }
  };
}

function singleTurnChatRepository(input: { updates?: number[]; storedAssistantBodies?: string[] }) {
  return {
    ...unusedChatRepository(),
    async createSingleAdvisorChat() {
      return { id: "chat-1" };
    },
    async setCurrentChat() {},
    async getCurrentChat() {
      return null;
    },
    async insertTelegramUserTurn(_config: ServerConfig, turnInput: { body: string }) {
      return {
        id: "user-message-1",
        turnId: "turn-1",
        role: "user" as const,
        body: turnInput.body,
        locale: "en" as const,
        createdAt: "2026-04-27T00:00:00.000Z"
      };
    },
    async insertAssistantTurn(
      _config: ServerConfig,
      turnInput: { chatId: string; turnId: string; body: string }
    ) {
      input.storedAssistantBodies?.push(turnInput.body);

      return {
        id: "assistant-message-1",
        turnId: turnInput.turnId,
        role: "assistant" as const,
        body: turnInput.body,
        locale: "en" as const,
        createdAt: "2026-04-27T00:00:01.000Z"
      };
    },
    async getAssistantTurn() {
      return null;
    },
    async updateAssistantTelegramMessageId(
      _config: ServerConfig,
      updateInput: { telegramMessageId: number }
    ) {
      input.updates?.push(updateInput.telegramMessageId);
    }
  };
}

function multiTurnChatRepository(input: { turns: string[]; selections?: string[]; updates?: number[] }) {
  return {
    ...unusedChatRepository(),
    async createMultiAdvisorChat() {
      return { id: "multi-chat" };
    },
    async setCurrentChat() {},
    async setMultiAdvisorSelection(
      _config: ServerConfig,
      selectionInput: { chatId: string; advisors: Array<{ advisorId: string }> }
    ) {
      selectionInput.advisors.forEach((advisor, index) => {
        input.selections?.push(`${selectionInput.chatId}:${index + 1}:${advisor.advisorId}`);
      });
    },
    async getCurrentChat() {
      return null;
    },
    async insertTelegramUserTurn(
      _config: ServerConfig,
      turnInput: { chatId: string; telegramMessageId: number; body: string; locale: string }
    ) {
      input.turns.push(
        `${turnInput.chatId}:${turnInput.telegramMessageId}:${turnInput.body}:${turnInput.locale}`
      );

      return {
        id: "user-message-1",
        turnId: "turn-1",
        role: "user" as const,
        body: turnInput.body,
        locale: "en" as const,
        createdAt: "2026-04-27T00:00:00.000Z"
      };
    },
    async insertAssistantTurn(
      _config: ServerConfig,
      turnInput: { turnId: string; body: string; advisorId: string }
    ) {
      return {
        id: `assistant-message-${turnInput.advisorId}`,
        turnId: turnInput.turnId,
        role: "assistant" as const,
        advisorId: turnInput.advisorId,
        body: turnInput.body,
        locale: "en" as const,
        createdAt: "2026-04-27T00:00:01.000Z"
      };
    },
    async getAssistantTurn() {
      return null;
    },
    async updateAssistantTelegramMessageId(
      _config: ServerConfig,
      updateInput: { telegramMessageId: number }
    ) {
      input.updates?.push(updateInput.telegramMessageId);
    }
  };
}


for (const locale of ["en", "ru"] as const) {
  for (const bare of [false, true]) {
    test(`Marcus opening is once per true dialogue in ${locale}, bare=${bare}, even with empty model history`, async () => {
      let current = "";
      let chatIndex = 0;
      let turnIndex = 0;
      const claims = new Map<string, string>();
      const sent: string[] = [];
      const dispatcher = new DefaultBotCommandDispatcher({
        advisorDirectory: advisorDirectory({ byCommand: { marcus_aurelius: MARCUS, paul_graham: PAUL } }),
        chatRepository: {
          ...singleTurnChatRepository({}),
          async createSingleAdvisorChat() { return { id: "opening-chat-" + (++chatIndex) }; },
          async setCurrentChat(_config, input) { current = input.chatId; },
          async getCurrentChat() { return { kind: "single_advisor" as const, id: current, advisorId: MARCUS.id, advisorDisplayName: MARCUS.displayName, locale }; },
          async insertTelegramUserTurn(_config, input) { return { id: "user-" + (++turnIndex), turnId: "turn-" + turnIndex, role: "user" as const, body: input.body, locale, createdAt: "2026-11-25T00:00:00Z" }; },
          async claimDialogueOpening(_config, input) {
            if (input.advisorId !== MARCUS.id) return false;
            if (!claims.has(input.chatId)) claims.set(input.chatId, input.turnId);
            return claims.get(input.chatId) === input.turnId;
          }
        },
        replyGenerator: {
          async listMessages() { return []; }, // A trimmed or empty model window is not a new dialogue.
          async generateReply() { return { replyText: "A practical step.", modelName: "offline", fragments: [] }; }
        },
        async telegramSender(_config, input) { sent.push(input.text); return { messageId: null }; }
      });
      const substantive = locale === "ru" ? "Как принять решение?" : "How should I decide?";
      await dispatcher.dispatch(CONFIG, { userId: "user-1", message: telegramMessage({ text: "/marcus_aurelius" + (bare ? "" : " " + substantive), languageCode: locale, entities: [{ type: "bot_command", offset: 0, length: 16 }] }) });
      await dispatcher.dispatch(CONFIG, { userId: "user-1", message: telegramMessage({ text: locale === "ru" ? "Пока" : "Hello, goodbye", messageId: 2, languageCode: locale }) });
      const token = locale === "ru" ? "Сальве" : "Salve";
      assert.ok(sent[0]?.startsWith("Marcus Aurelius: " + token + ". "));
      assert.equal(sent[1], "Marcus Aurelius: A practical step.");
      assert.ok(sent.every((text) => !text.includes("Vale")));
      await dispatcher.dispatch(CONFIG, { userId: "user-1", message: telegramMessage({ text: "/marcus_aurelius " + substantive, messageId: 3, languageCode: locale, entities: [{ type: "bot_command", offset: 0, length: 16 }] }) });
      assert.equal(sent[2], "Marcus Aurelius: " + token + ". A practical step.");
      await dispatcher.dispatch(CONFIG, { userId: "user-1", message: telegramMessage({ text: "/paul_graham A substantive question", messageId: 4, entities: [{ type: "bot_command", offset: 0, length: 12 }] }) });
      assert.equal(sent[3], "Paul Graham: A practical step.");
    });
  }
}

for (const [code, rpcName, tolerated] of [
  ["PGRST202", "quorum_claim_marcus_dialogue_opening", true],
  ["42883", "quorum_claim_marcus_dialogue_opening", true],
  ["PGRST202", "another_function", false],
  ["42501", "quorum_claim_marcus_dialogue_opening", false]
] as const) {
  test(`rolling upgrade skips only the precisely missing optional opening RPC: ${code}/${rpcName}`, async (t) => {
    const sent: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const route = new URL(request.url).pathname;
      if (route === "/rest/v1/chats") return Response.json([{ id: "rolling-chat" }]);
      if (route === "/rest/v1/chat_advisors" || route === "/rest/v1/telegram_chat_states") return new Response(null, { status: 201 });
      if (route === "/rest/v1/rpc/quorum_claim_marcus_dialogue_opening") {
        const body = await request.json() as Record<string, unknown>;
        assert.equal(body.p_chat_id, "rolling-chat");
        assert.equal(body.p_advisor_id, MARCUS.id);
        return Response.json({ code, message: `Could not find function public.${rpcName}` }, { status: 404 });
      }
      throw new Error(`Unexpected route ${route}`);
    });
    const dispatcher = new DefaultBotCommandDispatcher({
      advisorDirectory: advisorDirectory({ byCommand: { marcus_aurelius: MARCUS } }),
      replyGenerator: unusedReplyGenerator(),
      async telegramSender(_config, input) { sent.push(input.text); return { messageId: null }; }
    });
    const action = dispatcher.dispatch(CONFIG, { userId: "user-1", message: telegramMessage({
      text: "/marcus_aurelius", entities: [{ type: "bot_command", offset: 0, length: 16 }]
    }) });
    if (tolerated) {
      await action;
      assert.deepEqual(sent, ["Marcus Aurelius: What would you like to discuss or ask?"]);
    } else {
      await assert.rejects(action);
      assert.deepEqual(sent, []);
    }
  });
}

test("opening survives delivery retry without regenerating or appending another greeting", async () => {
  let stored: import("../../../lib/server/chats/types.ts").ChatMessageRecord | null = null;
  let generations = 0;
  let claims = 0;
  const attempts: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({}),
    chatRepository: {
      ...singleTurnChatRepository({}),
      async getCurrentChat() { return { kind: "single_advisor" as const, id: "retry-chat", advisorId: MARCUS.id, advisorDisplayName: MARCUS.displayName, locale: "en" as const }; },
      async getAssistantTurn() { return stored; },
      async claimDialogueOpening() { claims += 1; return true; },
      async insertAssistantTurn(_config, input) { stored = { id: "saved-opening", turnId: input.turnId, role: "assistant", body: input.body, locale: "en", createdAt: "2026-11-25T00:00:00Z" }; return stored; },
      async updateAssistantTelegramMessageId(_config, input) { if (stored) stored.telegramMessageId = input.telegramMessageId; }
    },
    replyGenerator: {
      async listMessages() { return []; },
      async generateReply() { generations += 1; return { replyText: "A practical step.", modelName: "offline", fragments: [] }; }
    },
    async telegramSender(_config, input) {
      attempts.push(input.text);
      if (attempts.length === 1) throw new Error("Offline delivery failure");
      return { messageId: 200 };
    }
  });
  const input = { userId: "user-1", message: telegramMessage({ text: "A substantive question", messageId: 70 }) };
  await assert.rejects(dispatcher.dispatch(CONFIG, input), /Offline delivery failure/);
  await dispatcher.dispatch(CONFIG, input);
  await dispatcher.dispatch(CONFIG, input);
  assert.equal(generations, 1);
  assert.equal(claims, 1);
  assert.deepEqual(attempts, ["Marcus Aurelius: Salve. A practical step.", "Marcus Aurelius: Salve. A practical step."]);
});
