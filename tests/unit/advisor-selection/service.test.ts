import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ServerConfig } from "../../../lib/server/config.ts";
import {
  advisorSelectionMinScore,
  AdvisorSelectionService,
  rankAdvisorSelectionRows,
  type AdvisorSelectionRow
} from "../../../lib/server/advisor-selection/service.ts";

const CONFIG: ServerConfig = {
  telegramBotToken: "123456:telegram-bot-token",
  telegramWebhookSecret: "secret",
  supabaseUrl: "http://supabase.test",
  supabaseSecretKey: "service-role"
};

test("selectForQuestion uses English as the retrieval pivot and maps ranked advisors", async () => {
  const translated: string[] = [];
  const embedded: string[] = [];
  const service = new AdvisorSelectionService({
    model: {
      async translateToEnglish(text) {
        translated.push(text);

        return "How should I handle fear?";
      },
      async createEmbedding(text) {
        embedded.push(text);

        return [0.1, 0.2, 0.3];
      }
    },
    repository: {
      async selectByEmbedding(_config, input) {
        assert.deepEqual(input.queryEmbedding, [0.1, 0.2, 0.3]);
        assert.equal(input.limit, 5);

        return [
          row({
            advisorId: "advisor-1",
            displayName: "Advisor One",
            displayNameKey: "advisor one",
            specialistFitScore: "0.66",
            topicTagScore: "0.66",
            dossierThemeScore: "0.2",
            sourceCoverageScore: "0.4"
          })
        ];
      }
    }
  });

  const result = await service.selectForQuestion(CONFIG, {
    question: "Как справиться со страхом?",
    locale: "ru",
    limit: 5
  });

  assert.deepEqual(translated, ["Как справиться со страхом?"]);
  assert.deepEqual(embedded, ["How should I handle fear?"]);
  assert.equal(result.selectedAdvisors[0]?.advisorId, "advisor-1");
  assert.equal(result.selectedAdvisors[0]?.selectionRank, 1);
});

test("ranking normalizes scores, filters below threshold, and applies documented tie-breaks", () => {
  const selected = rankAdvisorSelectionRows(
    [
      row({
        advisorId: "low-score",
        displayName: "Low Score",
        displayNameKey: "low score",
        specialistFitScore: "0.29",
        topicTagScore: "0.99",
        sourceCoverageScore: "0.99"
      }),
      row({
        advisorId: "source-wins",
        displayName: "Source Wins",
        displayNameKey: "source wins",
        specialistFitScore: "0.80",
        topicTagScore: "0.50",
        sourceCoverageScore: "0.70"
      }),
      row({
        advisorId: "tag-wins",
        displayName: "Tag Wins",
        displayNameKey: "tag wins",
        specialistFitScore: "0.80",
        topicTagScore: "0.60",
        sourceCoverageScore: "0.10"
      }),
      row({
        advisorId: "display-key-wins",
        displayName: "Alpha",
        displayNameKey: "alpha",
        specialistFitScore: "0.80",
        topicTagScore: "0.50",
        sourceCoverageScore: "0.70"
      }),
      row({
        advisorId: "clamped",
        displayName: "Clamped",
        displayNameKey: "clamped",
        specialistFitScore: "1.50",
        topicTagScore: "-0.20",
        dossierThemeScore: "2.00",
        sourceCoverageScore: "0.10"
      })
    ],
    { limit: 5, minScore: 0.3 }
  );

  assert.deepEqual(
    selected.map((advisor) => advisor.advisorId),
    ["clamped", "tag-wins", "display-key-wins", "source-wins"]
  );
  assert.equal(selected[0]?.specialistFitScore, 1);
  assert.equal(selected[0]?.selectionBasis.topicTagScore, 0);
  assert.deepEqual(
    selected.map((advisor) => advisor.selectionRank),
    [1, 2, 3, 4]
  );
});

test("selection limit never exceeds five advisors", () => {
  const rows = Array.from({ length: 7 }, (_, index) =>
    row({
      advisorId: `advisor-${index}`,
      displayName: `Advisor ${index}`,
      displayNameKey: `advisor ${index}`,
      specialistFitScore: "0.9"
    })
  );

  assert.equal(rankAdvisorSelectionRows(rows, { limit: 10, minScore: 0.3 }).length, 5);
});

test("selection service code has no launch-advisor hardcoded branches", () => {
  const source = readFileSync(
    new URL("../../../lib/server/advisor-selection/service.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /marcus|paul|graham/i);
});

test("selection SQL enforces launch eligibility, approved tags, and current profiles", () => {
  const migration = readFileSync(
    new URL("../../../supabase/migrations/0020_advisor_selection_scoring.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /advisor\.persona_status = 'active'/);
  assert.match(migration, /advisor\.readiness_status = 'advisor_ready'/);
  assert.match(migration, /advisor\.benchmark_passed_at is not null/);
  assert.match(migration, /advisor\.is_launch_enabled = true/);
  assert.match(migration, /tag\.tag_state = 'approved'/);
  assert.match(migration, /dossier\.artifact_state = 'approved'/);
  assert.match(migration, /dossier\.is_current = true/);
});

test("invalid ADVISOR_SELECTION_MIN_SCORE falls back to the release default", () => {
  const previous = process.env.ADVISOR_SELECTION_MIN_SCORE;

  process.env.ADVISOR_SELECTION_MIN_SCORE = "not-a-score";
  assert.equal(advisorSelectionMinScore(), 0.3);

  process.env.ADVISOR_SELECTION_MIN_SCORE = "0.42";
  assert.equal(advisorSelectionMinScore(), 0.42);

  if (previous === undefined) {
    delete process.env.ADVISOR_SELECTION_MIN_SCORE;
  } else {
    process.env.ADVISOR_SELECTION_MIN_SCORE = previous;
  }
});

function row(
  input: {
    advisorId: string;
    displayName: string;
    displayNameKey: string;
    specialistFitScore?: string;
    topicTagScore?: string;
    dossierThemeScore?: string;
    sourceCoverageScore?: string;
  }
): AdvisorSelectionRow {
  return {
    advisor_id: input.advisorId,
    display_name: input.displayName,
    display_name_key: input.displayNameKey,
    specialist_fit_score: input.specialistFitScore ?? "0.5",
    topic_tag_score: input.topicTagScore ?? "0.5",
    dossier_theme_score: input.dossierThemeScore ?? "0.5",
    source_coverage_score: input.sourceCoverageScore ?? "0.5",
    matched_topic_tag_keys: ["matched-tag"],
    matched_fragment_ids: ["00000000-0000-4000-8000-000000000001"]
  };
}
