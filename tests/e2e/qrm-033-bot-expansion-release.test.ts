import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStartMessage,
  DefaultBotCommandDispatcher
} from "../../lib/server/bot/dispatcher.ts";
import type { ChatLocale } from "../../lib/server/chats/types.ts";
import type { ServerConfig } from "../../lib/server/config.ts";
import { buildBoldPrefixEntity } from "../../lib/server/telegram/client.ts";
import type { TelegramMessage } from "../../lib/server/telegram/types.ts";

const CONFIG: ServerConfig = {
  telegramBotToken: "123456:telegram-bot-token",
  telegramWebhookSecret: "secret",
  supabaseUrl: "http://supabase.test",
  supabaseSecretKey: "service-role"
};

const GENERAL_DISCLAIMER =
  "Quorum advisors are AI agents inspired by real people and their documented ideas. They are not those people and are not official representatives of those people or their heirs. All responses are AI-generated based on publicly available sources.";

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

test("QRM-033 /start release copy follows Telegram locale and launch-enabled command data", async () => {
  const sent: string[] = [];
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({ list: [MARCUS, PAUL] }),
    chatRepository: unusedChatRepository(),
    replyGenerator: unusedReplyGenerator(),
    async telegramSender(_config, input) {
      sent.push(input.text);

      return { messageId: 1 };
    }
  });

  for (const languageCode of ["en", "ru-RU", "fr-CA"]) {
    await dispatcher.dispatch(CONFIG, {
      userId: "user-1",
      message: telegramMessage({
        text: "/start@quorum_bot",
        entities: [{ type: "bot_command", offset: 0, length: 17 }],
        languageCode
      })
    });
  }

  assert.equal(sent[0], buildStartMessage([MARCUS, PAUL], "en"));
  assert.equal(sent[1], buildStartMessage([MARCUS, PAUL], "ru-RU"));
  assert.equal(sent[2], buildStartMessage([MARCUS, PAUL], "fr-CA"));
  assert.match(sent[1] ?? "", /Задайте свой вопрос Quorum в этом чате\./);
  assert.match(sent[2] ?? "", /Ask Quorum in this chat\./);

  for (const text of sent) {
    assert.match(text, /\/marcus_aurelius - Marcus Aurelius/);
    assert.match(text, /\/paul_graham - Paul Graham/);
    assert.doesNotMatch(text, /\/ask/);
  }

  assert.equal((sent[0]?.match(new RegExp(escapeRegExp(GENERAL_DISCLAIMER), "g")) ?? []).length, 1);
  assert.equal((sent[2]?.match(new RegExp(escapeRegExp(GENERAL_DISCLAIMER), "g")) ?? []).length, 1);
});

test("QRM-033 advisor commands honor launch eligibility and inline-question behavior", async () => {
  const sent: Array<{ text: string; entities: unknown }> = [];
  const calls: string[] = [];
  const launchByCommand = new Map([[MARCUS.telegramCommand, MARCUS]]);
  const chatRepository = releaseChatRepository({ calls });
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({
      byCommand: launchByCommand
    }),
    chatRepository,
    replyGenerator: {
      async listMessages() {
        return [];
      },
      async generateReply(_config, input) {
        return {
          fragments: [],
          modelName: "test-model",
          replyText: `${input.advisorDisplayName}: answer for ${input.userBody}`
        };
      }
    },
    async telegramSender(_config, input) {
      sent.push({ text: input.text, entities: input.entities });

      return { messageId: 10 + sent.length };
    }
  });

  assert.deepEqual(
    await dispatcher.dispatch(CONFIG, {
      userId: "user-1",
      message: commandMessage("/paul_graham Is this live?")
    }),
    { chatId: null, turnId: null }
  );
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);

  await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: commandMessage("/marcus_aurelius How should I act?")
  });
  assert.equal(calls.includes(`create-single:${MARCUS.id}:en`), true);
  assert.equal(calls.includes("turn:single-1:How should I act?"), true);
  assert.deepEqual(sent.at(-1), {
    text: "Marcus Aurelius: answer for How should I act?",
    entities: [buildBoldPrefixEntity("Marcus Aurelius")]
  });

  launchByCommand.set(PAUL.telegramCommand, PAUL);
  await dispatcher.dispatch(CONFIG, {
    userId: "user-1",
    message: commandMessage("/paul_graham")
  });
  assert.equal(calls.includes(`create-single:${PAUL.id}:en`), true);
  assert.equal(calls.some((call) => call === "turn:single-2:"), false);
  assert.deepEqual(sent.at(-1), {
    text: "Paul Graham: What would you like to discuss or ask?",
    entities: [buildBoldPrefixEntity("Paul Graham")]
  });
});

test("QRM-033 multi-advisor release paths fan out to at most five isolated public answers", async () => {
  const advisors = [MARCUS, PAUL, 3, 4, 5].map((advisor) =>
    typeof advisor === "number"
      ? launchAdvisor({
          id: `00000000-0000-4000-8000-00000000000${advisor}`,
          telegramCommand: `advisor_${advisor}`,
          displayName: `Advisor ${advisor}`,
          displayNameKey: `advisor ${advisor}`
        })
      : advisor
  );
  const sent: string[] = [];
  const calls: string[] = [];
  const conversationAssertions: string[] = [];
  const chatRepository = releaseChatRepository({ calls });
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({ list: advisors }),
    advisorSelector: {
      async selectForQuestion(_config, input) {
        assert.equal(input.limit, 5);

        return {
          selectedAdvisors: advisors.map((advisor, index) => ({
            advisorId: advisor.id,
            displayName: advisor.displayName,
            selectionRank: index + 1,
            specialistFitScore: 0.9 - index / 100,
            selectionBasis: {
              topicTagScore: 0.8,
              dossierThemeScore: 0.7,
              sourceCoverageScore: 0.6,
              matchedTopicTagKeys: [`internal-tag-${index}`],
              matchedFragmentIds: [`fragment-${index}`]
            }
          }))
        };
      }
    },
    chatRepository,
    replyGenerator: {
      async listMessages() {
        return [
          {
            id: "other-message",
            turnId: "previous-turn",
            role: "assistant" as const,
            advisorId: MARCUS.id,
            body: "Marcus Aurelius: prior answer",
            locale: "en" as const,
            createdAt: "2026-05-07T00:00:00.000Z"
          }
        ];
      },
      async generateReply(_config, input) {
        assert.ok(
          input.conversation.every(
            (message) => message.role === "user" || message.advisorId === input.advisorId
          )
        );
        conversationAssertions.push(input.advisorDisplayName);

        return {
          fragments: [],
          modelName: "test-model",
          replyText:
            `${input.advisorDisplayName}: public answer\n`
            + "matchedTopicTagKeys=[internal]\n"
            + "https://www.paulgraham.com/articles.html\n"
            + "storage_path=advisors/paul-graham/corpus/text/pg-startup.txt"
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
    message: commandMessage("/all How should I choose?")
  });
  await dispatcher.dispatch(CONFIG, {
    userId: "user-2",
    message: telegramMessage({ text: "What needs my attention first?" })
  });

  assert.equal(calls.filter((call) => call.startsWith("selection:")).length, 2);
  assert.ok(calls.every((call) => !call.startsWith("selection:") || call.split(",").length <= 5));
  assert.equal(conversationAssertions.length, 10);
  assert.deepEqual(sent.slice(0, 5), [
    "Marcus Aurelius: public answer",
    "Paul Graham: public answer",
    "Advisor 3: public answer",
    "Advisor 4: public answer",
    "Advisor 5: public answer"
  ]);

  for (const text of sent) {
    assert.doesNotMatch(text, /matchedTopicTagKeys|https?:\/\/|storage_path|source_key|selection_rank/);
  }
});

test("QRM-033 legacy /ask remains inert in the release path", async () => {
  const dispatcher = new DefaultBotCommandDispatcher({
    advisorDirectory: advisorDirectory({ list: [MARCUS, PAUL] }),
    advisorSelector: {
      async selectForQuestion() {
        throw new Error("unexpected advisor selection");
      }
    },
    chatRepository: releaseChatRepository({ calls: [] }),
    replyGenerator: unusedReplyGenerator(),
    async telegramSender() {
      throw new Error("unexpected Telegram send");
    }
  });

  assert.deepEqual(
    await dispatcher.dispatch(CONFIG, {
      userId: "user-1",
      message: commandMessage("/ask Paul Graham how do I start?")
    }),
    { chatId: null, turnId: null }
  );
});

function commandMessage(text: string): TelegramMessage {
  return telegramMessage({
    text,
    entities: [{ type: "bot_command", offset: 0, length: text.split(/\s/, 1)[0]?.length ?? text.length }]
  });
}

function telegramMessage(input: {
  text: string;
  entities?: TelegramMessage["entities"];
  languageCode?: string | null;
}): TelegramMessage {
  return {
    message_id: 55,
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

function advisorDirectory(input: {
  list?: ReturnType<typeof launchAdvisor>[];
  byCommand?: Map<string, ReturnType<typeof launchAdvisor>>;
}) {
  return {
    async listLaunchEnabledAdvisors() {
      return input.list ?? [];
    },
    async getLaunchEnabledAdvisorByTelegramCommand(_config: ServerConfig, telegramCommand: string) {
      return input.byCommand?.get(telegramCommand) ?? null;
    }
  };
}

function releaseChatRepository(input: { calls: string[] }) {
  let singleIndex = 0;
  let multiIndex = 0;
  let turnIndex = 0;

  return {
    async createSingleAdvisorChat(
      _config: ServerConfig,
    chatInput: { advisorId: string; locale: ChatLocale }
    ) {
      singleIndex += 1;
      input.calls.push(`create-single:${chatInput.advisorId}:${chatInput.locale}`);

      return { id: `single-${singleIndex}` };
    },
    async createMultiAdvisorChat(_config: ServerConfig, chatInput: { locale: ChatLocale }) {
      multiIndex += 1;
      input.calls.push(`create-multi:${chatInput.locale}`);

      return { id: `multi-${multiIndex}` };
    },
    async setMultiAdvisorSelection(
      _config: ServerConfig,
      selectionInput: { chatId: string; advisors: Array<{ advisorId: string }> }
    ) {
      input.calls.push(
        `selection:${selectionInput.chatId}:${selectionInput.advisors
          .map((advisor) => advisor.advisorId)
          .join(",")}`
      );
    },
    async setCurrentChat(_config: ServerConfig, currentInput: { chatId: string }) {
      input.calls.push(`current:${currentInput.chatId}`);
    },
    async getCurrentChat() {
      return null;
    },
    async insertTelegramUserTurn(
      _config: ServerConfig,
      turnInput: { chatId: string; body: string; locale: ChatLocale }
    ) {
      turnIndex += 1;
      input.calls.push(`turn:${turnInput.chatId}:${turnInput.body}`);

      return {
        id: `user-message-${turnIndex}`,
        turnId: `turn-${turnIndex}`,
        role: "user" as const,
        body: turnInput.body,
        locale: turnInput.locale,
        createdAt: "2026-05-07T00:00:00.000Z"
      };
    },
    async insertAssistantTurn(
      _config: ServerConfig,
      turnInput: { turnId: string; advisorId: string; body: string; locale: ChatLocale }
    ) {
      return {
        id: `assistant-message-${turnInput.advisorId}-${turnInput.turnId}`,
        turnId: turnInput.turnId,
        role: "assistant" as const,
        advisorId: turnInput.advisorId,
        body: turnInput.body,
        locale: turnInput.locale,
        createdAt: "2026-05-07T00:00:01.000Z"
      };
    },
    async getAssistantTurn() {
      return null;
    },
    async claimDialogueOpening() { return false; },
    async updateAssistantTelegramMessageId() {}
  };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
