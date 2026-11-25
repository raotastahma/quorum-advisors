import type { ServerConfig } from "../config.ts";
import { postgrest } from "../supabase.ts";
import type {
  AdvisorDossierRecord,
  AdvisorRuntimeRecord,
  ChatLocale,
  ChatMessageRecord,
  ChatRecord,
  ChatRepository,
  GroundingWrite,
  PreparedTurn,
  RetrievedFragment
} from "./types.ts";

type AdvisorRow = {
  id: string;
  slug: string;
  display_name: string;
  persona_status: string;
  readiness_status: string;
  benchmark_passed_at: string | null;
  is_launch_enabled: boolean;
  supported_locales: ChatLocale[];
};

type ChatRow = {
  id: string;
  user_id: string;
  advisor_id: string;
  locale: ChatLocale;
  status: "active" | "closed";
  created_at: string;
  last_message_at: string;
  advisors?: AdvisorRow | AdvisorRow[];
};

type MessageRow = {
  id: string;
  turn_id: string;
  role: "user" | "assistant";
  advisor_id?: string | null;
  telegram_message_id?: number | null;
  body_text: string;
  locale: ChatLocale;
  created_at: string;
};

type PreparedTurnRow = {
  user_message_id: string;
  turn_id: string;
  user_body_text: string;
  user_locale: ChatLocale;
  user_created_at: string;
  assistant_message_id: string | null;
  assistant_body_text: string | null;
  assistant_locale: ChatLocale | null;
  assistant_created_at: string | null;
};

type FinalizedTurnRow = {
  assistant_message_id: string;
  turn_id: string;
  body_text: string;
  locale: ChatLocale;
  created_at: string;
};

type DossierRow = {
  advisors?: { slug: string };
  id: string;
  version: number;
  payload: {
    tone?: Partial<AdvisorDossierRecord["tone"]>;
    red_lines?: string[];
    core_ideas?: Array<{ statement?: string }>;
    argument_patterns?: Array<{ description?: string }>;
    secondary_context_notes?: Array<{ note?: string }>;
  };
};

type FragmentRow = {
  corpus_fragment_id: string;
  fragment_index: number;
  original_text: string;
  retrieval_text_en: string;
  original_language_code: string;
  source_key: string;
  document_title: string;
  similarity_score: number | string | null;
};

export class SupabaseChatRepository implements ChatRepository {
  async getChat(config: ServerConfig, chatId: string): Promise<ChatRecord | null> {
    const rows = await postgrest<ChatRow[]>(config, {
      path: "chats",
      query: {
        select:
          "id,user_id,advisor_id,locale,status,created_at,last_message_at,advisors!inner(id,slug,display_name,persona_status,readiness_status,benchmark_passed_at,is_launch_enabled,supported_locales)",
        id: `eq.${chatId}`,
        limit: "1"
      }
    });
    const row = rows[0];
    const advisorRow = Array.isArray(row?.advisors) ? row.advisors[0] : row?.advisors;

    return row && advisorRow ? mapChat(row, mapAdvisor(advisorRow)) : null;
  }

  async listMessages(config: ServerConfig, chatId: string): Promise<ChatMessageRecord[]> {
    const rows = await postgrest<MessageRow[]>(config, {
      path: "chat_messages",
      query: {
        select: "id,turn_id,role,advisor_id,body_text,locale,created_at",
        chat_id: `eq.${chatId}`,
        order: "created_at.asc,id.asc",
        limit: "1000"
      }
    });

    return rows.map(mapMessage);
  }

  async prepareTurn(
    config: ServerConfig,
    input: { chatId: string; clientMessageId: string; body: string; locale: ChatLocale }
  ): Promise<PreparedTurn> {
    const rows = await postgrest<PreparedTurnRow[]>(config, {
      method: "POST",
      path: "rpc/quorum_prepare_chat_turn",
      body: {
        p_chat_id: input.chatId,
        p_client_message_id: input.clientMessageId,
        p_body_text: input.body,
        p_locale: input.locale
      }
    });
    const row = rows[0];

    if (!row) {
      throw new Error("Turn preparation returned no row.");
    }

    return {
      userMessage: {
        id: row.user_message_id,
        turnId: row.turn_id,
        role: "user",
        body: row.user_body_text,
        locale: row.user_locale,
        createdAt: row.user_created_at
      },
      assistantMessage:
        row.assistant_message_id &&
        row.assistant_body_text &&
        row.assistant_locale &&
        row.assistant_created_at
          ? {
              id: row.assistant_message_id,
              turnId: row.turn_id,
              role: "assistant",
              body: row.assistant_body_text,
              locale: row.assistant_locale,
              createdAt: row.assistant_created_at
            }
          : null
    };
  }

  async finalizeTurn(
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
  ): Promise<ChatMessageRecord> {
    const rows = await postgrest<FinalizedTurnRow[]>(config, {
      method: "POST",
      path: "rpc/quorum_finalize_chat_turn",
      body: {
        p_chat_id: input.chatId,
        p_turn_id: input.turnId,
        p_body_text: input.body,
        p_locale: input.locale,
        p_model_name: input.modelName,
        p_prompt_version: input.promptVersion,
        p_groundings: input.groundings
      }
    });
    const row = rows[0];

    if (!row) {
      throw new Error("Turn finalization returned no row.");
    }

    return {
      id: row.assistant_message_id,
      turnId: row.turn_id,
      role: "assistant",
      advisorId: null,
      body: row.body_text,
      locale: row.locale,
      createdAt: row.created_at
    };
  }

  async getCurrentDossier(
    config: ServerConfig,
    advisorId: string
  ): Promise<AdvisorDossierRecord | null> {
    const rows = await postgrest<DossierRow[]>(config, {
      path: "advisor_dossiers",
      query: {
        select: "id,version,payload,advisors!inner(slug)",
        advisor_id: `eq.${advisorId}`,
        artifact_state: "eq.approved",
        is_current: "eq.true",
        limit: "1"
      }
    });
    const row = rows[0];

    if (!row) {
      return null;
    }

    const tone = row.payload.tone ?? {};

    return {
      id: row.id,
      version: row.version,
      advisorSlug: row.advisors?.slug,
      tone: {
        voice: tone.voice ?? "",
        cadence: tone.cadence ?? "",
        do: tone.do ?? [],
        avoid: tone.avoid ?? []
      },
      redLines: row.payload.red_lines ?? [],
      coreIdeas: (row.payload.core_ideas ?? []).flatMap((idea) =>
        typeof idea.statement === "string" ? [idea.statement] : []
      ),
      argumentPatterns: (row.payload.argument_patterns ?? []).flatMap((pattern) =>
        typeof pattern.description === "string" ? [pattern.description] : []
      ),
      secondaryContextNotes: (row.payload.secondary_context_notes ?? []).flatMap((note) =>
        typeof note.note === "string" ? [note.note] : []
      )
    };
  }

  async matchApprovedFragments(
    config: ServerConfig,
    input: { advisorId: string; queryEmbedding: number[]; limit: number }
  ): Promise<RetrievedFragment[]> {
    const rows = await postgrest<FragmentRow[]>(config, {
      method: "POST",
      path: "rpc/quorum_match_corpus_fragments",
      body: {
        p_advisor_id: input.advisorId,
        p_query_embedding: `[${input.queryEmbedding.join(",")}]`,
        p_match_count: input.limit
      }
    });

    return rows.map((row) => ({
      id: row.corpus_fragment_id,
      fragmentIndex: row.fragment_index,
      originalText: row.original_text,
      retrievalTextEn: row.retrieval_text_en,
      originalLanguageCode: row.original_language_code,
      sourceKey: row.source_key,
      documentTitle: row.document_title,
      similarityScore:
        row.similarity_score === null ? null : Number.parseFloat(String(row.similarity_score))
    }));
  }
}

function mapAdvisor(row: AdvisorRow): AdvisorRuntimeRecord {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    personaStatus: row.persona_status,
    readinessStatus: row.readiness_status,
    benchmarkPassedAt: row.benchmark_passed_at,
    isLaunchEnabled: row.is_launch_enabled,
    supportedLocales: row.supported_locales
  };
}

function mapChat(row: ChatRow, advisor: AdvisorRuntimeRecord): ChatRecord {
  return {
    id: row.id,
    userId: row.user_id,
    advisorId: row.advisor_id,
    locale: row.locale,
    status: row.status,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    advisor
  };
}

function mapMessage(row: MessageRow): ChatMessageRecord {
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
