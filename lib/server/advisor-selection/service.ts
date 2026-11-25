import type { ServerConfig } from "../config.ts";
import type { ChatLocale, ChatModelAdapter } from "../chats/types.ts";
import { OpenAiChatModel } from "../model/openai.ts";
import { detectReplyLanguage } from "../rag/service.ts";
import { postgrest } from "../supabase.ts";

export const DEFAULT_ADVISOR_SELECTION_MIN_SCORE = 0.3;
const MAX_SELECTION_LIMIT = 5;

export type AdvisorSelectionBasis = {
  topicTagScore: number;
  dossierThemeScore: number;
  sourceCoverageScore: number;
  matchedTopicTagKeys: string[];
  matchedFragmentIds: string[];
};

export type SelectedAdvisor = {
  advisorId: string;
  displayName: string;
  selectionRank: number;
  specialistFitScore: number;
  selectionBasis: AdvisorSelectionBasis;
};

export type AdvisorSelectionRow = {
  advisor_id: string;
  display_name: string;
  display_name_key: string;
  specialist_fit_score: number | string | null;
  topic_tag_score: number | string | null;
  dossier_theme_score: number | string | null;
  source_coverage_score: number | string | null;
  matched_topic_tag_keys: string[] | null;
  matched_fragment_ids: string[] | null;
};

interface AdvisorSelectionRepository {
  selectByEmbedding(
    config: ServerConfig,
    input: { queryEmbedding: number[]; minScore: number; limit: number }
  ): Promise<AdvisorSelectionRow[]>;
}

type AdvisorSelectionModel = Pick<ChatModelAdapter, "createEmbedding" | "translateToEnglish">;
type RankedAdvisorSelection = SelectedAdvisor & { displayNameKey: string };

export class AdvisorSelectionService {
  private readonly model: AdvisorSelectionModel;
  private readonly repository: AdvisorSelectionRepository;

  constructor(
    dependencies: {
      model?: AdvisorSelectionModel;
      repository?: AdvisorSelectionRepository;
    } = {}
  ) {
    this.model = dependencies.model ?? new OpenAiChatModel();
    this.repository = dependencies.repository ?? new PostgrestAdvisorSelectionRepository();
  }

  async selectForQuestion(
    config: ServerConfig,
    input: { question: string; locale: ChatLocale; limit?: number }
  ): Promise<{ selectedAdvisors: SelectedAdvisor[] }> {
    const question = input.question.trim();

    if (question.length === 0) {
      return { selectedAdvisors: [] };
    }

    const limit = normalizeSelectionLimit(input.limit);
    const minScore = advisorSelectionMinScore();
    const queryText =
      detectReplyLanguage(question, input.locale) === "ru"
        ? await this.model.translateToEnglish(question)
        : question;
    const queryEmbedding = await this.model.createEmbedding(queryText);
    const rows = await this.repository.selectByEmbedding(config, {
      queryEmbedding,
      minScore,
      limit
    });

    return {
      selectedAdvisors: rankAdvisorSelectionRows(rows, { limit, minScore })
    };
  }
}

export function rankAdvisorSelectionRows(
  rows: AdvisorSelectionRow[],
  input: { limit: number; minScore: number }
): SelectedAdvisor[] {
  return rows
    .map(mapSelectionRow)
    .filter((advisor) => advisor.specialistFitScore >= input.minScore)
    .sort(compareSelectedAdvisors)
    .slice(0, normalizeSelectionLimit(input.limit))
    .map((advisor, index) => ({
      ...withoutDisplayNameKey(advisor),
      selectionRank: index + 1
    }));
}

export function advisorSelectionMinScore(): number {
  const configured = Number.parseFloat(process.env.ADVISOR_SELECTION_MIN_SCORE ?? "");

  if (Number.isFinite(configured) && configured >= 0 && configured <= 1) {
    return configured;
  }

  return DEFAULT_ADVISOR_SELECTION_MIN_SCORE;
}

class PostgrestAdvisorSelectionRepository implements AdvisorSelectionRepository {
  async selectByEmbedding(
    config: ServerConfig,
    input: { queryEmbedding: number[]; minScore: number; limit: number }
  ): Promise<AdvisorSelectionRow[]> {
    return postgrest<AdvisorSelectionRow[]>(config, {
      method: "POST",
      path: "rpc/quorum_select_advisors_for_question",
      body: {
        p_query_embedding: `[${input.queryEmbedding.join(",")}]`,
        p_min_score: input.minScore,
        p_limit: input.limit
      }
    });
  }
}

function mapSelectionRow(row: AdvisorSelectionRow): RankedAdvisorSelection {
  const topicTagScore = normalizedScore(row.topic_tag_score);
  const dossierThemeScore = normalizedScore(row.dossier_theme_score);
  const sourceCoverageScore = normalizedScore(row.source_coverage_score);

  return {
    advisorId: row.advisor_id,
    displayName: row.display_name,
    displayNameKey: row.display_name_key,
    selectionRank: 0,
    specialistFitScore: normalizedScore(
      row.specialist_fit_score ?? Math.max(topicTagScore, dossierThemeScore, sourceCoverageScore)
    ),
    selectionBasis: {
      topicTagScore,
      dossierThemeScore,
      sourceCoverageScore,
      matchedTopicTagKeys: row.matched_topic_tag_keys ?? [],
      matchedFragmentIds: row.matched_fragment_ids ?? []
    }
  };
}

function compareSelectedAdvisors(
  left: RankedAdvisorSelection,
  right: RankedAdvisorSelection
): number {
  return (
    right.specialistFitScore - left.specialistFitScore ||
    right.selectionBasis.topicTagScore - left.selectionBasis.topicTagScore ||
    right.selectionBasis.sourceCoverageScore - left.selectionBasis.sourceCoverageScore ||
    left.displayNameKey.localeCompare(right.displayNameKey)
  );
}

function normalizedScore(value: number | string | null): number {
  const score = typeof value === "number" ? value : Number.parseFloat(value ?? "0");

  if (!Number.isFinite(score)) {
    return 0;
  }

  return Math.min(1, Math.max(0, score));
}

function normalizeSelectionLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    return MAX_SELECTION_LIMIT;
  }

  return Math.min(limit, MAX_SELECTION_LIMIT);
}

function withoutDisplayNameKey(advisor: RankedAdvisorSelection): SelectedAdvisor {
  return {
    advisorId: advisor.advisorId,
    displayName: advisor.displayName,
    selectionRank: advisor.selectionRank,
    specialistFitScore: advisor.specialistFitScore,
    selectionBasis: advisor.selectionBasis
  };
}
