import type { ServerConfig } from "../config.ts";
import { UpstreamUnavailableError } from "../supabase.ts";
import type {
  ChatLocale,
  ChatMessageRecord,
  ChatModelAdapter,
  ChatRepository,
  RetrievedFragment
} from "../chats/types.ts";
import { applyToneDirectives } from "./tone.ts";

export const CHAT_PROMPT_VERSION = "qrm-010-v1";

export class RagService {
  private readonly model: ChatModelAdapter;
  private readonly repository: ChatRepository;
  private readonly retrievalLimit: number;

  constructor(
    repository: ChatRepository,
    model: ChatModelAdapter,
    options: { retrievalLimit?: number } = {}
  ) {
    this.repository = repository;
    this.model = model;
    this.retrievalLimit = options.retrievalLimit ?? 6;
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
    const dossier = await this.repository.getCurrentDossier(config, input.advisorId);

    if (!dossier) {
      throw new UpstreamUnavailableError("Current approved advisor dossier is missing.");
    }

    const replyLanguage = detectReplyLanguage(input.userBody, input.chatLocale);
    const retrievalQuery =
      replyLanguage === "ru"
        ? await this.model.translateToEnglish(input.userBody)
        : input.userBody.trim();
    const embedding = await this.model.createEmbedding(retrievalQuery);
    const fragments = await this.repository.matchApprovedFragments(config, {
      advisorId: input.advisorId,
      queryEmbedding: embedding,
      limit: this.retrievalLimit
    });

    if (fragments.length === 0) {
      throw new UpstreamUnavailableError("No approved fragments are available for retrieval.");
    }

    const generated = await this.model.generateAdvisorReply({
      userBody: input.userBody,
      advisorDisplayName: input.advisorDisplayName,
      replyLanguage,
      chatLocale: input.chatLocale,
      conversation: input.conversation,
      dossier,
      fragments
    });
    const replyText = applyToneDirectives({
      userBody: input.userBody,
      rawReply: generated.text,
      tone: dossier.tone
    });

    if (replyText.length === 0) {
      throw new UpstreamUnavailableError("Generated advisor reply was empty.");
    }

    return {
      fragments,
      modelName: generated.modelName,
      replyText
    };
  }
}

export function detectReplyLanguage(userBody: string, fallbackLocale: ChatLocale): ChatLocale {
  if (/[А-Яа-яЁё]/.test(userBody)) {
    return "ru";
  }

  if (/[A-Za-z]/.test(userBody)) {
    return "en";
  }

  return fallbackLocale;
}
