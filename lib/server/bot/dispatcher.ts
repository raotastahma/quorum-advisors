import {
  getLaunchEnabledAdvisorByTelegramCommand,
  listLaunchEnabledAdvisors,
  type LaunchAdvisorSummary
} from "../advisors/advisors.ts";
import {
  AdvisorSelectionService,
  type AdvisorSelectionBasis,
  type SelectedAdvisor
} from "../advisor-selection/service.ts";
import type { ServerConfig } from "../config.ts";
import { OpenAiChatModel } from "../model/openai.ts";
import { CHAT_PROMPT_VERSION, detectReplyLanguage, RagService } from "../rag/service.ts";
import { postgrest } from "../supabase.ts";
import {
  buildBoldPrefixEntity,
  sendTelegramMessage,
  type TelegramSender
} from "../telegram/client.ts";
import type { TelegramMessage } from "../telegram/types.ts";
import { SupabaseChatRepository } from "../chats/repository.ts";
import type { ChatLocale, ChatMessageRecord, RetrievedFragment } from "../chats/types.ts";

export interface BotDispatchInput {
  userId: string;
  message: TelegramMessage;
}

export interface BotDispatchResult {
  chatId: string | null;
  turnId: string | null;
}

export interface BotCommandDispatcher {
  dispatch(config: ServerConfig, input: BotDispatchInput): Promise<BotDispatchResult>;
}

interface CurrentSingleAdvisorChat {
  kind: "single_advisor";
  id: string;
  advisorId: string;
  advisorDisplayName: string;
  locale: ChatLocale;
}

interface SelectedMultiAdvisor {
  advisorId: string;
  advisorDisplayName: string;
  selectionRank?: number;
  specialistFitScore?: number;
  selectionBasis?: AdvisorSelectionBasis;
}

interface CurrentMultiAdvisorChat {
  kind: "multi_advisor";
  id: string;
  locale: ChatLocale;
  advisors?: SelectedMultiAdvisor[];
}

type CurrentBotChat = CurrentSingleAdvisorChat | CurrentMultiAdvisorChat;

interface BotChatRepository {
  createSingleAdvisorChat(
    config: ServerConfig,
    input: {
      userId: string;
      telegramChatId: number;
      advisorId: string;
      locale: ChatLocale;
    }
  ): Promise<{ id: string }>;
  createMultiAdvisorChat(
    config: ServerConfig,
    input: {
      userId: string;
      telegramChatId: number;
      locale: ChatLocale;
    }
  ): Promise<{ id: string }>;
  setMultiAdvisorSelection(
    config: ServerConfig,
    input: {
      chatId: string;
      advisors: SelectedMultiAdvisor[];
    }
  ): Promise<void>;
  setCurrentChat(
    config: ServerConfig,
    input: { userId: string; telegramChatId: number; chatId: string }
  ): Promise<void>;
  getCurrentChat(
    config: ServerConfig,
    input: { userId: string; telegramChatId: number }
  ): Promise<CurrentBotChat | null>;
  insertTelegramUserTurn(
    config: ServerConfig,
    input: { chatId: string; telegramMessageId: number; body: string; locale: ChatLocale }
  ): Promise<ChatMessageRecord>;
  insertAssistantTurn(
    config: ServerConfig,
    input: {
      chatId: string;
      turnId: string;
      advisorId: string;
      body: string;
      locale: ChatLocale;
      modelName: string;
      promptVersion: string;
      groundings: Array<{ corpusFragmentId: string; rankOrder: number; similarityScore: number | null }>;
    }
  ): Promise<ChatMessageRecord>;
  getAssistantTurn(
    config: ServerConfig,
    input: { chatId: string; turnId: string; advisorId: string }
  ): Promise<ChatMessageRecord | null>;
  updateAssistantTelegramMessageId(
    config: ServerConfig,
    input: { messageId: string; telegramMessageId: number }
  ): Promise<void>;
}

interface AdvisorDirectory {
  listLaunchEnabledAdvisors(config: ServerConfig): Promise<LaunchAdvisorSummary[]>;
  getLaunchEnabledAdvisorByTelegramCommand(
    config: ServerConfig,
    telegramCommand: string
  ): Promise<LaunchAdvisorSummary | null>;
}

interface AdvisorSelector {
  selectForQuestion(
    config: ServerConfig,
    input: { question: string; locale: ChatLocale; limit: number }
  ): Promise<{ selectedAdvisors: SelectedAdvisor[] }>;
}

interface ReplyGenerator {
  generateReply(
    config: ServerConfig,
    input: {
      advisorId: string;
      advisorDisplayName: string;
      userBody: string;
      chatLocale: ChatLocale;
      conversation: ChatMessageRecord[];
    }
  ): Promise<{ fragments: RetrievedFragment[]; modelName: string; replyText: string }>;
  listMessages(config: ServerConfig, chatId: string): Promise<ChatMessageRecord[]>;
}

type ParsedBotCommand =
  | { kind: "command"; name: string; args: string }
  | { kind: "ordinary_text"; text: string };

const CHAT_STARTED_TEXT = "Chat started. Send your question.";
export const TELEGRAM_SEND_MESSAGE_TEXT_LIMIT = 4096;
const GENERAL_DISCLAIMER =
  "Quorum advisors are AI agents inspired by real people and their documented ideas. They are not those people and are not official representatives of those people or their heirs. All responses are AI-generated based on publicly available sources.";
const APPROVED_START_MESSAGE_TEMPLATES = {
  en: englishStartMessageTemplate,
  ru: russianStartMessageTemplate
} satisfies Record<string, StartMessageTemplate>;

export class DefaultBotCommandDispatcher implements BotCommandDispatcher {
  private readonly advisorDirectory: AdvisorDirectory;
  private readonly advisorSelector: AdvisorSelector;
  private readonly chatRepository: BotChatRepository;
  private readonly replyGenerator: ReplyGenerator;
  private readonly telegramSender: TelegramSender;

  constructor(
    dependencies: {
      chatRepository?: BotChatRepository;
      advisorDirectory?: AdvisorDirectory;
      advisorSelector?: AdvisorSelector;
      replyGenerator?: ReplyGenerator;
      telegramSender?: TelegramSender;
    } = {}
  ) {
    const chatRuntimeRepository = new SupabaseChatRepository();

    this.advisorDirectory = dependencies.advisorDirectory ?? {
      listLaunchEnabledAdvisors,
      getLaunchEnabledAdvisorByTelegramCommand
    };
    this.advisorSelector = dependencies.advisorSelector ?? new AdvisorSelectionService();
    this.chatRepository = dependencies.chatRepository ?? new SupabaseBotChatRepository();
    this.replyGenerator =
      dependencies.replyGenerator ??
      new RagReplyGenerator(
        chatRuntimeRepository,
        new RagService(chatRuntimeRepository, new OpenAiChatModel())
      );
    this.telegramSender = dependencies.telegramSender ?? sendTelegramMessage;
  }

  async dispatch(config: ServerConfig, input: BotDispatchInput): Promise<BotDispatchResult> {
    const parsed = parseTelegramBotCommand(input.message);

    if (parsed.kind === "command" && parsed.name === "start") {
      const advisors = await this.advisorDirectory.listLaunchEnabledAdvisors(config);

      await this.telegramSender(config, {
        chatId: input.message.chat.id,
        text: buildStartMessage(advisors, input.message.from.language_code)
      });

      return emptyDispatchResult();
    }

    if (parsed.kind === "command" && parsed.name === "ask") {
      return emptyDispatchResult();
    }

    if (parsed.kind === "command" && parsed.name === "all") {
      return this.dispatchAll(config, input, parsed.args);
    }

    if (parsed.kind === "command") {
      return this.dispatchAdvisorCommand(config, input, parsed.name, parsed.args);
    }

    if (parsed.kind === "ordinary_text") {
      return this.dispatchOrdinaryText(config, input, parsed.text);
    }

    return emptyDispatchResult();
  }

  private async dispatchAdvisorCommand(
    config: ServerConfig,
    input: BotDispatchInput,
    telegramCommand: string,
    inlineQuestion: string
  ): Promise<BotDispatchResult> {
    const advisor = await this.advisorDirectory.getLaunchEnabledAdvisorByTelegramCommand(
      config,
      telegramCommand
    );

    if (!advisor) {
      return emptyDispatchResult();
    }

    const locale = inferInitialChatLocale(input.message, inlineQuestion);
    const chat = await this.chatRepository.createSingleAdvisorChat(config, {
      userId: input.userId,
      telegramChatId: input.message.chat.id,
      advisorId: advisor.id,
      locale
    });

    await this.chatRepository.setCurrentChat(config, {
      userId: input.userId,
      telegramChatId: input.message.chat.id,
      chatId: chat.id
    });

    if (inlineQuestion.length === 0) {
      const greetingText = `${advisor.displayName}: What would you like to discuss or ask?`;

      await this.telegramSender(config, {
        chatId: input.message.chat.id,
        text: greetingText,
        entities: [buildBoldPrefixEntity(advisor.displayName)]
      });

      return {
        chatId: chat.id,
        turnId: null
      };
    }

    return this.processSingleAdvisorTurn(config, input.message, {
      kind: "single_advisor",
      id: chat.id,
      advisorId: advisor.id,
      advisorDisplayName: advisor.displayName,
      locale
    }, inlineQuestion);
  }

  private async dispatchAll(
    config: ServerConfig,
    input: BotDispatchInput,
    inlineQuestion: string
  ): Promise<BotDispatchResult> {
    const locale = inferInitialChatLocale(input.message, inlineQuestion);
    const chat = await this.chatRepository.createMultiAdvisorChat(config, {
      userId: input.userId,
      telegramChatId: input.message.chat.id,
      locale
    });

    await this.chatRepository.setCurrentChat(config, {
      userId: input.userId,
      telegramChatId: input.message.chat.id,
      chatId: chat.id
    });

    if (inlineQuestion.length === 0) {
      await this.telegramSender(config, {
        chatId: input.message.chat.id,
        text: CHAT_STARTED_TEXT
      });

      return {
        chatId: chat.id,
        turnId: null
      };
    }

    return this.processMultiAdvisorQuestion(config, input.message, {
      kind: "multi_advisor",
      id: chat.id,
      locale
    }, inlineQuestion);
  }

  private async dispatchOrdinaryText(
    config: ServerConfig,
    input: BotDispatchInput,
    body: string
  ): Promise<BotDispatchResult> {
    const chat = await this.chatRepository.getCurrentChat(config, {
      userId: input.userId,
      telegramChatId: input.message.chat.id
    });

    if (!chat) {
      return this.dispatchAll(config, input, body.trim());
    }

    if (chat.kind === "multi_advisor") {
      return this.processMultiAdvisorQuestion(config, input.message, chat, body.trim());
    }

    return this.processSingleAdvisorTurn(config, input.message, chat, body.trim());
  }

  private async processSingleAdvisorTurn(
    config: ServerConfig,
    message: TelegramMessage,
    chat: CurrentSingleAdvisorChat,
    body: string
  ): Promise<BotDispatchResult> {
    const userLocale = detectReplyLanguage(body, chat.locale);
    const userMessage = await this.chatRepository.insertTelegramUserTurn(config, {
      chatId: chat.id,
      telegramMessageId: message.message_id,
      body,
      locale: userLocale
    });
    const assistantMessage = await this.getOrCreateAdvisorAssistantMessage(config, {
      chatId: chat.id,
      turnId: userMessage.turnId,
      advisorId: chat.advisorId,
      advisorDisplayName: chat.advisorDisplayName,
      userBody: userMessage.body,
      userLocale,
      chatLocale: chat.locale,
      conversation: (await this.replyGenerator.listMessages(config, chat.id)).slice(-12)
    });
    await this.sendAssistantMessageIfNeeded(config, message.chat.id, {
      assistantMessage,
      advisorDisplayName: chat.advisorDisplayName
    });

    return {
      chatId: chat.id,
      turnId: userMessage.turnId
    };
  }

  private async processMultiAdvisorQuestion(
    config: ServerConfig,
    message: TelegramMessage,
    chat: CurrentMultiAdvisorChat,
    body: string
  ): Promise<BotDispatchResult> {
    const userLocale = detectReplyLanguage(body, chat.locale);
    const userMessage = await this.chatRepository.insertTelegramUserTurn(config, {
      chatId: chat.id,
      telegramMessageId: message.message_id,
      body,
      locale: userLocale
    });
    const advisors = await this.ensureMultiAdvisorSelection(config, chat, userMessage.body);
    const rankedAdvisors = sortSelectedAdvisors(advisors);

    if (rankedAdvisors.length === 0) {
      return {
        chatId: chat.id,
        turnId: userMessage.turnId
      };
    }

    const history = await this.replyGenerator.listMessages(config, chat.id);
    const advisorMessages = await Promise.all(
      rankedAdvisors.map(async (advisor) => ({
        advisor,
        assistantMessage: await this.getOrCreateAdvisorAssistantMessage(config, {
          chatId: chat.id,
          turnId: userMessage.turnId,
          advisorId: advisor.advisorId,
          advisorDisplayName: advisor.advisorDisplayName,
          userBody: userMessage.body,
          userLocale,
          chatLocale: chat.locale,
          conversation: history
            .filter(
              (historyMessage) =>
                historyMessage.role === "user" || historyMessage.advisorId === advisor.advisorId
            )
            .slice(-12)
        })
      }))
    );

    for (const advisorMessage of advisorMessages) {
      await this.sendAssistantMessageIfNeeded(config, message.chat.id, {
        assistantMessage: advisorMessage.assistantMessage,
        advisorDisplayName: advisorMessage.advisor.advisorDisplayName
      });
    }

    return {
      chatId: chat.id,
      turnId: userMessage.turnId
    };
  }

  private async ensureMultiAdvisorSelection(
    config: ServerConfig,
    chat: CurrentMultiAdvisorChat,
    question: string
  ): Promise<SelectedMultiAdvisor[]> {
    const existingAdvisors = chat.advisors ?? [];

    if (existingAdvisors.length > 0) {
      return existingAdvisors;
    }

    const selection = await this.advisorSelector.selectForQuestion(config, {
      question,
      locale: chat.locale,
      limit: 5
    });
    const advisors = selection.selectedAdvisors.map((advisor) => ({
      advisorId: advisor.advisorId,
      advisorDisplayName: advisor.displayName,
      selectionRank: advisor.selectionRank,
      specialistFitScore: advisor.specialistFitScore,
      selectionBasis: advisor.selectionBasis
    }));

    if (advisors.length > 0) {
      await this.chatRepository.setMultiAdvisorSelection(config, {
        chatId: chat.id,
        advisors
      });
    }

    return advisors;
  }

  private async getOrCreateAdvisorAssistantMessage(
    config: ServerConfig,
    input: {
      chatId: string;
      turnId: string;
      advisorId: string;
      advisorDisplayName: string;
      userBody: string;
      userLocale: ChatLocale;
      chatLocale: ChatLocale;
      conversation: ChatMessageRecord[];
    }
  ): Promise<ChatMessageRecord> {
    const existingMessage = await this.chatRepository.getAssistantTurn(config, {
      chatId: input.chatId,
      turnId: input.turnId,
      advisorId: input.advisorId
    });

    if (existingMessage) {
      return existingMessage;
    }

    const generated = await this.replyGenerator.generateReply(config, {
      advisorId: input.advisorId,
      advisorDisplayName: input.advisorDisplayName,
      userBody: input.userBody,
      chatLocale: input.chatLocale,
      conversation: input.conversation
    });
    const replyText = truncateTelegramAdvisorReply(
      ensureAdvisorPrefix(sanitizePublicAdvisorReply(generated.replyText), input.advisorDisplayName)
    );

    return this.chatRepository.insertAssistantTurn(config, {
      chatId: input.chatId,
      turnId: input.turnId,
      advisorId: input.advisorId,
      body: replyText,
      locale: input.userLocale,
      modelName: generated.modelName,
      promptVersion: CHAT_PROMPT_VERSION,
      groundings: generated.fragments.map((fragment, index) => ({
        corpusFragmentId: fragment.id,
        rankOrder: index + 1,
        similarityScore: fragment.similarityScore
      }))
    });
  }

  private async sendAssistantMessageIfNeeded(
    config: ServerConfig,
    telegramChatId: number,
    input: { assistantMessage: ChatMessageRecord; advisorDisplayName: string }
  ): Promise<void> {
    if (input.assistantMessage.telegramMessageId !== null && input.assistantMessage.telegramMessageId !== undefined) {
      return;
    }

    const telegramMessage = await this.telegramSender(config, {
      chatId: telegramChatId,
      text: input.assistantMessage.body,
      entities: [buildBoldPrefixEntity(input.advisorDisplayName)]
    });

    if (telegramMessage.messageId !== null) {
      await this.chatRepository.updateAssistantTelegramMessageId(config, {
        messageId: input.assistantMessage.id,
        telegramMessageId: telegramMessage.messageId
      });
    }
  }
}

export function parseTelegramBotCommand(message: TelegramMessage): ParsedBotCommand {
  const commandEntity = message.entities?.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0
  );

  if (!commandEntity) {
    return {
      kind: "ordinary_text",
      text: message.text
    };
  }

  const commandToken = message.text.slice(0, commandEntity.length);
  const commandName = commandToken.slice(1).split("@", 1)[0];
  const args = message.text.slice(commandEntity.length).trim();

  return {
    kind: "command",
    name: commandName,
    args
  };
}

export type StartMessageTemplate = (input: {
  advisorCommandExamples: string;
  advisorCommandLines: string;
}) => string;

export function buildStartMessage(
  advisors: Array<{ telegramCommand: string; displayName: string }>,
  languageCode?: string | null,
  templates: Record<string, StartMessageTemplate> = APPROVED_START_MESSAGE_TEMPLATES
): string {
  const locale = selectApprovedStartMessageLocale(languageCode, templates);
  const advisorCommandExamples =
    advisors.length === 0
      ? "none yet"
      : advisors
          .map((advisor) => `/${advisor.telegramCommand} <question> - ${advisor.displayName}`)
          .join("\n");
  const advisorCommandLines =
    advisors.length === 0
      ? "none yet"
      : advisors.map((advisor) => `/${advisor.telegramCommand} - ${advisor.displayName}`).join("\n");

  return templates[locale]({
    advisorCommandExamples,
    advisorCommandLines
  });
}

export function selectApprovedStartMessageLocale(
  languageCode: string | null | undefined,
  templates: Record<string, StartMessageTemplate> = APPROVED_START_MESSAGE_TEMPLATES
): string {
  const primarySubtag = languageCode?.trim().toLowerCase().split(/[-_]/, 1)[0];

  return primarySubtag && templates[primarySubtag] ? primarySubtag : "en";
}

export function ensureAdvisorPrefix(text: string, displayName: string): string {
  const trimmed = text.trim();
  const expectedPrefix = `${displayName}:`;

  if (trimmed.startsWith(expectedPrefix)) {
    return trimmed;
  }

  return `${expectedPrefix} ${trimmed}`;
}

export function sanitizePublicAdvisorReply(text: string): string {
  const safeLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !containsInternalGroundingLeak(line));

  return safeLines.join("\n").trim() || "I cannot expose internal source details.";
}

export function truncateTelegramAdvisorReply(text: string): string {
  const characters = Array.from(text);

  if (characters.length <= TELEGRAM_SEND_MESSAGE_TEXT_LIMIT) {
    return text;
  }

  return characters.slice(0, TELEGRAM_SEND_MESSAGE_TEXT_LIMIT).join("");
}

function containsInternalGroundingLeak(line: string): boolean {
  return (
    /https?:\/\/\S+/i.test(line) ||
    /(source_key|document_id|fragment_index|provenance|grounding|corpus_documents|corpus_fragments|topic_tags?|tag_key|matchedTopicTagKeys|matchedFragmentIds|selection_basis|selection_rank|selectionRank|specialistFitScore|specialist_fit_score|topicTagScore|dossierThemeScore|sourceCoverageScore)/i.test(
      line
    ) ||
    /\b(raw_storage_path|storage_path|private storage)\b/i.test(line) ||
    /\badvisors\/paul-graham\/corpus\b/i.test(line) ||
    /\bpaul-graham\/corpus\/text\/[a-z0-9-]+\.txt\b/i.test(line)
  );
}

function sortSelectedAdvisors(advisors: SelectedMultiAdvisor[]): SelectedMultiAdvisor[] {
  return advisors
    .map((advisor, index) => ({ advisor, index }))
    .sort(
      (left, right) =>
        (left.advisor.selectionRank ?? left.index + 1) -
          (right.advisor.selectionRank ?? right.index + 1) || left.index - right.index
    )
    .map((entry) => entry.advisor);
}

function inferInitialChatLocale(message: TelegramMessage, question: string): ChatLocale {
  if (question.length > 0) {
    return detectReplyLanguage(question, fallbackLocaleFromTelegramMessage(message));
  }

  return fallbackLocaleFromTelegramMessage(message);
}

function fallbackLocaleFromTelegramMessage(message: TelegramMessage): ChatLocale {
  return message.from.language_code?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function emptyDispatchResult(): BotDispatchResult {
  return {
    chatId: null,
    turnId: null
  };
}

class RagReplyGenerator implements ReplyGenerator {
  private readonly chatRepository: SupabaseChatRepository;
  private readonly ragService: RagService;

  constructor(chatRepository: SupabaseChatRepository, ragService: RagService) {
    this.chatRepository = chatRepository;
    this.ragService = ragService;
  }

  async listMessages(config: ServerConfig, chatId: string): Promise<ChatMessageRecord[]> {
    return this.chatRepository.listMessages(config, chatId);
  }

  async generateReply(
    config: ServerConfig,
    input: {
      advisorId: string;
      advisorDisplayName: string;
      userBody: string;
      chatLocale: ChatLocale;
      conversation: ChatMessageRecord[];
    }
  ): Promise<{ fragments: RetrievedFragment[]; modelName: string; replyText: string }> {
    return this.ragService.generateReply(config, input);
  }
}

class SupabaseBotChatRepository implements BotChatRepository {
  async createSingleAdvisorChat(
    config: ServerConfig,
    input: {
      userId: string;
      telegramChatId: number;
      advisorId: string;
      locale: ChatLocale;
    }
  ): Promise<{ id: string }> {
    const chatRows = await postgrest<Array<{ id: string }>>(config, {
      method: "POST",
      path: "chats",
      prefer: "return=representation",
      body: {
        user_id: input.userId,
        telegram_chat_id: input.telegramChatId,
        chat_kind: "single_advisor",
        locale: input.locale
      }
    });
    const chat = chatRows[0];

    if (!chat) {
      throw new Error("Single-advisor chat creation returned no row.");
    }

    await postgrest<unknown>(config, {
      method: "POST",
      path: "chat_advisors",
      body: {
        chat_id: chat.id,
        advisor_id: input.advisorId,
        selection_rank: 1,
        selection_basis: {
          source: "telegram_single_advisor_command"
        }
      }
    });

    return chat;
  }

  async createMultiAdvisorChat(
    config: ServerConfig,
    input: {
      userId: string;
      telegramChatId: number;
      locale: ChatLocale;
    }
  ): Promise<{ id: string }> {
    const chatRows = await postgrest<Array<{ id: string }>>(config, {
      method: "POST",
      path: "chats",
      prefer: "return=representation",
      body: {
        user_id: input.userId,
        telegram_chat_id: input.telegramChatId,
        chat_kind: "multi_advisor",
        locale: input.locale
      }
    });
    const chat = chatRows[0];

    if (!chat) {
      throw new Error("Multi-advisor chat creation returned no row.");
    }

    return chat;
  }

  async setMultiAdvisorSelection(
    config: ServerConfig,
    input: { chatId: string; advisors: SelectedMultiAdvisor[] }
  ): Promise<void> {
    if (input.advisors.length === 0) {
      return;
    }

    await postgrest<unknown>(config, {
      method: "POST",
      path: "chat_advisors",
      body: input.advisors.map((advisor, index) => ({
        chat_id: input.chatId,
        advisor_id: advisor.advisorId,
        selection_rank: advisor.selectionRank ?? index + 1,
        specialist_fit_score: advisor.specialistFitScore ?? null,
        selection_basis: advisor.selectionBasis ?? {
          source: "telegram_all_command"
        }
      }))
    });
  }

  async setCurrentChat(
    config: ServerConfig,
    input: { userId: string; telegramChatId: number; chatId: string }
  ): Promise<void> {
    await postgrest<unknown>(config, {
      method: "POST",
      path: "telegram_chat_states",
      query: {
        on_conflict: "telegram_chat_id"
      },
      prefer: "resolution=merge-duplicates",
      body: {
        telegram_chat_id: input.telegramChatId,
        user_id: input.userId,
        current_chat_id: input.chatId
      }
    });
  }

  async getCurrentChat(
    config: ServerConfig,
    input: { userId: string; telegramChatId: number }
  ): Promise<CurrentBotChat | null> {
    const stateRows = await postgrest<Array<{ current_chat_id: string | null }>>(config, {
      path: "telegram_chat_states",
      query: {
        select: "current_chat_id",
        telegram_chat_id: `eq.${input.telegramChatId}`,
        user_id: `eq.${input.userId}`,
        limit: "1"
      }
    });
    const currentChatId = stateRows[0]?.current_chat_id;

    if (!currentChatId) {
      return null;
    }

    const chatRows = await postgrest<
      Array<{ id: string; locale: ChatLocale; status: string; chat_kind: string }>
    >(config, {
      path: "chats",
      query: {
        select: "id,locale,status,chat_kind",
        id: `eq.${currentChatId}`,
        user_id: `eq.${input.userId}`,
        telegram_chat_id: `eq.${input.telegramChatId}`,
        status: "eq.active",
        limit: "1"
      }
    });
    const chat = chatRows[0];

    if (!chat) {
      return null;
    }

    if (chat.chat_kind === "multi_advisor") {
      const advisors = await this.listMultiAdvisorSelection(config, chat.id);

      return {
        kind: "multi_advisor",
        id: chat.id,
        locale: chat.locale,
        advisors
      };
    }

    const advisorRows = await postgrest<
      Array<{
        advisor_id: string;
        selection_rank: number;
        advisors?: {
          display_name: string;
        };
      }>
    >(config, {
      path: "chat_advisors",
      query: {
        select:
          "advisor_id,advisors!inner(display_name,persona_status,readiness_status,benchmark_passed_at,is_launch_enabled)",
        chat_id: `eq.${chat.id}`,
        selection_rank: "eq.1",
        "advisors.persona_status": "eq.active",
        "advisors.readiness_status": "eq.advisor_ready",
        "advisors.benchmark_passed_at": "not.is.null",
        "advisors.is_launch_enabled": "eq.true",
        limit: "1"
      }
    });
    const advisor = advisorRows[0];

    if (!advisor?.advisors) {
      return null;
    }

    return {
      kind: "single_advisor",
      id: chat.id,
      advisorId: advisor.advisor_id,
      advisorDisplayName: advisor.advisors.display_name,
      locale: chat.locale
    };
  }

  private async listMultiAdvisorSelection(
    config: ServerConfig,
    chatId: string
  ): Promise<SelectedMultiAdvisor[]> {
    const advisorRows = await postgrest<
      Array<{
        advisor_id: string;
        selection_rank: number;
        advisors?: {
          display_name: string;
        };
      }>
    >(config, {
      path: "chat_advisors",
      query: {
        select:
          "advisor_id,selection_rank,advisors!inner(display_name,persona_status,readiness_status,benchmark_passed_at,is_launch_enabled)",
        chat_id: `eq.${chatId}`,
        "advisors.persona_status": "eq.active",
        "advisors.readiness_status": "eq.advisor_ready",
        "advisors.benchmark_passed_at": "not.is.null",
        "advisors.is_launch_enabled": "eq.true",
        order: "selection_rank.asc"
      }
    });

    return advisorRows.flatMap((advisor) =>
      advisor.advisors
        ? [
            {
              advisorId: advisor.advisor_id,
              advisorDisplayName: advisor.advisors.display_name,
              selectionRank: advisor.selection_rank
            }
          ]
        : []
    );
  }

  async insertTelegramUserTurn(
    config: ServerConfig,
    input: { chatId: string; telegramMessageId: number; body: string; locale: ChatLocale }
  ): Promise<ChatMessageRecord> {
    const turnId = crypto.randomUUID();
    let rows: Array<{
      id: string;
      turn_id: string;
      role: "user";
      advisor_id: null;
      telegram_message_id: number | null;
      body_text: string;
      locale: ChatLocale;
      created_at: string;
    }>;

    try {
      rows = await postgrest<
        Array<{
          id: string;
          turn_id: string;
          role: "user";
          advisor_id: null;
          telegram_message_id: number | null;
          body_text: string;
          locale: ChatLocale;
          created_at: string;
        }>
      >(config, {
        method: "POST",
        path: "chat_messages",
        prefer: "return=representation",
        body: {
          chat_id: input.chatId,
          turn_id: turnId,
          role: "user",
          telegram_message_id: input.telegramMessageId,
          body_text: input.body,
          locale: input.locale
        }
      });
    } catch (error) {
      const existingMessage = await this.getTelegramUserTurn(config, {
        chatId: input.chatId,
        telegramMessageId: input.telegramMessageId
      });

      if (existingMessage) {
        return existingMessage;
      }

      throw error;
    }

    const row = rows[0];

    if (!row) {
      throw new Error("Telegram user turn insert returned no row.");
    }

    await this.touchChat(config, input.chatId);

    return mapMessage(row);
  }

  private async getTelegramUserTurn(
    config: ServerConfig,
    input: { chatId: string; telegramMessageId: number }
  ): Promise<ChatMessageRecord | null> {
    const rows = await postgrest<
      Array<{
        id: string;
        turn_id: string;
        role: "user";
        advisor_id: null;
        telegram_message_id: number | null;
        body_text: string;
        locale: ChatLocale;
        created_at: string;
      }>
    >(config, {
      path: "chat_messages",
      query: {
        select: "id,turn_id,role,advisor_id,telegram_message_id,body_text,locale,created_at",
        chat_id: `eq.${input.chatId}`,
        telegram_message_id: `eq.${input.telegramMessageId}`,
        role: "eq.user",
        limit: "1"
      }
    });

    return rows[0] ? mapMessage(rows[0]) : null;
  }

  async insertAssistantTurn(
    config: ServerConfig,
    input: {
      chatId: string;
      turnId: string;
      advisorId: string;
      body: string;
      locale: ChatLocale;
      modelName: string;
      promptVersion: string;
      groundings: Array<{ corpusFragmentId: string; rankOrder: number; similarityScore: number | null }>;
    }
  ): Promise<ChatMessageRecord> {
    let row:
      | {
          id: string;
          turn_id: string;
          role: "assistant";
          advisor_id: string;
          telegram_message_id: number | null;
          body_text: string;
          locale: ChatLocale;
          created_at: string;
        }
      | undefined;

    try {
      const rows = await postgrest<
        Array<{
          id: string;
          turn_id: string;
          role: "assistant";
          advisor_id: string;
          telegram_message_id: number | null;
          body_text: string;
          locale: ChatLocale;
          created_at: string;
        }>
      >(config, {
        method: "POST",
        path: "chat_messages",
        prefer: "return=representation",
        body: {
          chat_id: input.chatId,
          turn_id: input.turnId,
          role: "assistant",
          advisor_id: input.advisorId,
          body_text: input.body,
          locale: input.locale,
          model_name: input.modelName,
          prompt_version: input.promptVersion
        }
      });

      row = rows[0];
    } catch (error) {
      const existingMessage = await this.getAssistantTurn(config, input);

      if (existingMessage) {
        await this.upsertAssistantGroundings(config, existingMessage.id, input.groundings);
        await this.touchChat(config, input.chatId);

        return existingMessage;
      }

      throw error;
    }

    if (!row) {
      throw new Error("Assistant turn insert returned no row.");
    }

    await this.upsertAssistantGroundings(config, row.id, input.groundings);
    await this.touchChat(config, input.chatId);

    return mapMessage(row);
  }

  async getAssistantTurn(
    config: ServerConfig,
    input: { chatId: string; turnId: string; advisorId: string }
  ): Promise<ChatMessageRecord | null> {
    const rows = await postgrest<
      Array<{
        id: string;
        turn_id: string;
        role: "assistant";
        advisor_id: string;
        telegram_message_id: number | null;
        body_text: string;
        locale: ChatLocale;
        created_at: string;
      }>
    >(config, {
      path: "chat_messages",
      query: {
        select: "id,turn_id,role,advisor_id,telegram_message_id,body_text,locale,created_at",
        chat_id: `eq.${input.chatId}`,
        turn_id: `eq.${input.turnId}`,
        advisor_id: `eq.${input.advisorId}`,
        role: "eq.assistant",
        limit: "1"
      }
    });

    return rows[0] ? mapMessage(rows[0]) : null;
  }

  private async upsertAssistantGroundings(
    config: ServerConfig,
    assistantMessageId: string,
    groundings: Array<{ corpusFragmentId: string; rankOrder: number; similarityScore: number | null }>
  ): Promise<void> {
    if (groundings.length === 0) {
      return;
    }

    await postgrest<unknown>(config, {
      method: "POST",
      path: "chat_message_groundings",
      query: {
        on_conflict: "assistant_message_id,corpus_fragment_id"
      },
      prefer: "resolution=merge-duplicates",
      body: groundings.map((grounding) => ({
        assistant_message_id: assistantMessageId,
        message_role: "assistant",
        corpus_fragment_id: grounding.corpusFragmentId,
        rank_order: grounding.rankOrder,
        similarity_score: grounding.similarityScore
      }))
    });
  }

  async updateAssistantTelegramMessageId(
    config: ServerConfig,
    input: { messageId: string; telegramMessageId: number }
  ): Promise<void> {
    await postgrest<unknown>(config, {
      method: "PATCH",
      path: "chat_messages",
      query: {
        id: `eq.${input.messageId}`
      },
      body: {
        telegram_message_id: input.telegramMessageId
      }
    });
  }

  private async touchChat(config: ServerConfig, chatId: string): Promise<void> {
    await postgrest<unknown>(config, {
      method: "PATCH",
      path: "chats",
      query: {
        id: `eq.${chatId}`
      },
      body: {
        last_message_at: new Date().toISOString()
      }
    });
  }
}

function englishStartMessageTemplate(input: {
  advisorCommandExamples: string;
  advisorCommandLines: string;
}): string {
  return [
    "Ask Quorum in this chat.",
    "",
    "To start a new chat, send /all or an advisor command.",
    "",
    "Available advisors:",
    input.advisorCommandLines,
    "",
    "Ask all relevant advisors:",
    "/all",
    "",
    "DISCLAIMER:",
    GENERAL_DISCLAIMER
  ].join("\n");
}

function russianStartMessageTemplate(input: {
  advisorCommandExamples: string;
  advisorCommandLines: string;
}): string {
  return [
    "Задайте свой вопрос Quorum в этом чате.",
    "",
    "Чтобы начать новый чат, отправьте /all или команду советника.",
    "",
    "Доступные советники:",
    input.advisorCommandLines,
    "",
    "Спросить всех подходящих советников:",
    "/all",
    "",
    "ДИСКЛЕЙМЕР:",
    "Советники Quorum — это ИИ-агенты, вдохновленные реальными людьми и их задокументированными идеями. Они не являются этими людьми и не являются официальными представителями этих людей или их наследников. Все ответы сгенерированы ИИ на основе публично доступных источников."
  ].join("\n");
}

function mapMessage(row: {
  id: string;
  turn_id: string;
  role: "user" | "assistant";
  advisor_id?: string | null;
  telegram_message_id?: number | null;
  body_text: string;
  locale: ChatLocale;
  created_at: string;
}): ChatMessageRecord {
  return {
    id: row.id,
    turnId: row.turn_id,
    role: row.role,
    advisorId: row.advisor_id ?? null,
    telegramMessageId: row.telegram_message_id ?? null,
    body: row.body_text,
    locale: row.locale,
    createdAt: row.created_at
  };
}

export const defaultBotCommandDispatcher = new DefaultBotCommandDispatcher();
