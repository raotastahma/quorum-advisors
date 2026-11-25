import type { ServerConfig } from "../config.ts";

export type ChatLocale = "en" | "ru";
export type ChatStatus = "active" | "closed";
export type MessageRole = "user" | "assistant";

export type AdvisorRuntimeRecord = {
  id: string;
  slug: string;
  displayName: string;
  personaStatus: string;
  readinessStatus: string;
  benchmarkPassedAt: string | null;
  isLaunchEnabled: boolean;
  supportedLocales: ChatLocale[];
};

export type ChatRecord = {
  id: string;
  userId: string;
  advisorId: string;
  locale: ChatLocale;
  status: ChatStatus;
  createdAt: string;
  lastMessageAt: string;
  advisor: AdvisorRuntimeRecord;
};

export type ChatMessageRecord = {
  id: string;
  turnId: string;
  role: MessageRole;
  advisorId?: string | null;
  telegramMessageId?: number | null;
  body: string;
  locale: ChatLocale;
  createdAt: string;
};

export type PreparedTurn = {
  userMessage: ChatMessageRecord;
  assistantMessage: ChatMessageRecord | null;
};

export type GroundingWrite = {
  corpusFragmentId: string;
  rankOrder: number;
  similarityScore: number | null;
};

export type ToneInstructions = {
  voice: string;
  cadence: string;
  do: string[];
  avoid: string[];
};

export type AdvisorDossierRecord = {
  advisorSlug?: string;
  id: string;
  version: number;
  tone: ToneInstructions;
  redLines: string[];
  coreIdeas: string[];
  argumentPatterns: string[];
  secondaryContextNotes: string[];
};

export type RetrievedFragment = {
  id: string;
  fragmentIndex: number;
  originalText: string;
  retrievalTextEn: string;
  originalLanguageCode: string;
  sourceKey: string;
  documentTitle: string;
  similarityScore: number | null;
};

export type ChatRepository = {
  getChat(config: ServerConfig, chatId: string): Promise<ChatRecord | null>;
  listMessages(config: ServerConfig, chatId: string): Promise<ChatMessageRecord[]>;
  prepareTurn(
    config: ServerConfig,
    input: { chatId: string; clientMessageId: string; body: string; locale: ChatLocale }
  ): Promise<PreparedTurn>;
  finalizeTurn(
    config: ServerConfig,
    input: {
      chatId: string;
      turnId: string;
      body: string;
      locale: ChatLocale;
      modelName: string;
      promptVersion: string;
      groundings: GroundingWrite[];
    }
  ): Promise<ChatMessageRecord>;
  getCurrentDossier(
    config: ServerConfig,
    advisorId: string
  ): Promise<AdvisorDossierRecord | null>;
  matchApprovedFragments(
    config: ServerConfig,
    input: { advisorId: string; queryEmbedding: number[]; limit: number }
  ): Promise<RetrievedFragment[]>;
};

export type ChatModelAdapter = {
  translateToEnglish(text: string): Promise<string>;
  createEmbedding(text: string): Promise<number[]>;
  generateAdvisorReply(input: {
    advisorDisplayName: string;
    userBody: string;
    replyLanguage: ChatLocale;
    chatLocale: ChatLocale;
    conversation: ChatMessageRecord[];
    dossier: AdvisorDossierRecord;
    fragments: RetrievedFragment[];
  }): Promise<{ modelName: string; text: string }>;
};
