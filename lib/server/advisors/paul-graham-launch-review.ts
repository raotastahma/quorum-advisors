import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PAUL_GRAHAM_INDEX_URL,
  verifyPaulGrahamSourceCatalog
} from "./paul-graham-source-catalog.ts";
import { validateAdvisorWorkspace } from "./workspace.ts";

const ADVISOR_SLUG = "paul-graham";
const WORKSPACE_PATH = path.join(process.cwd(), "advisors", ADVISOR_SLUG);
const ARTIFACT_DIR = path.join(process.cwd(), "artifacts", ADVISOR_SLUG);
const EMBEDDING_DIMENSIONS = 1536;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type CheckStatus = "pass" | "fail" | "blocked";

export type LaunchReviewCheck = {
  key: string;
  label: string;
  status: CheckStatus;
  summary: string;
  evidence: JsonObject;
  blockers: string[];
};

export type PaulGrahamLaunchReviewPacket = {
  schema_version: 1;
  packet_key: "paul-graham-launch-review-packet-v1";
  advisor_slug: "paul-graham";
  generated_at: string;
  official_index_url: string;
  recommendation: "ready_for_human_go" | "no_go";
  launch_blocked_until: string[];
  checks: LaunchReviewCheck[];
  benchmark_run_evidence: JsonObject;
  source_catalog_evidence: JsonObject;
  workspace_checksum_sha256: string | null;
};

export type GeneratePaulGrahamLaunchReviewPacketOptions = {
  workspacePath?: string;
  artifactDir?: string;
  officialIndexHtml?: string;
  benchmarkRunPath?: string;
  generatedAt?: string;
};

export async function generatePaulGrahamLaunchReviewPacket(
  options: GeneratePaulGrahamLaunchReviewPacketOptions = {}
): Promise<PaulGrahamLaunchReviewPacket> {
  const workspacePath = path.resolve(options.workspacePath ?? WORKSPACE_PATH);
  const artifactDir = path.resolve(options.artifactDir ?? ARTIFACT_DIR);
  const benchmarkRunPath =
    options.benchmarkRunPath ?? path.join(artifactDir, "benchmark-runs-v1.json");
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const [
    workspaceResult,
    sourceCatalogCheck,
    advisor,
    sourceCatalog,
    topicTags,
    dossier,
    selectionProfile,
    benchmarkScenarios,
    corpusManifest,
    benchmarkRun
  ] = await Promise.all([
    validateAdvisorWorkspace(workspacePath),
    checkedSourceCatalog(workspacePath, options.officialIndexHtml),
    readJsonObject(path.join(workspacePath, "advisor.json")),
    readJsonObject(path.join(workspacePath, "source-catalog.json")),
    readJsonObject(path.join(workspacePath, "topic-tags.json")),
    readJsonObject(path.join(workspacePath, "dossier-v1.json")),
    readJsonObject(path.join(workspacePath, "selection-profile-v1.json")),
    readJsonObject(path.join(workspacePath, "benchmark-scenarios-v1.json")),
    readJsonObject(path.join(workspacePath, "corpus", "manifest.json")),
    readOptionalJsonObject(benchmarkRunPath)
  ]);

  const checks = [
    sourceCatalogReadiness(sourceCatalogCheck),
    workspaceValidationReadiness(workspaceResult.errors),
    corpusReadiness(corpusManifest),
    topicTagReadiness(topicTags),
    dossierReadiness(dossier, workspaceResult.errors),
    selectionProfileReadiness(selectionProfile, topicTags, dossier),
    benchmarkScenarioReadiness(benchmarkScenarios, topicTags),
    benchmarkRunReadiness(benchmarkRun, benchmarkScenarios),
    launchSafetyReadiness(advisor)
  ];
  const recommendation = checks.every((check) => check.status === "pass")
    ? "ready_for_human_go"
    : "no_go";
  const packet: PaulGrahamLaunchReviewPacket = {
    schema_version: 1,
    packet_key: "paul-graham-launch-review-packet-v1",
    advisor_slug: ADVISOR_SLUG,
    generated_at: generatedAt,
    official_index_url: PAUL_GRAHAM_INDEX_URL,
    recommendation,
    launch_blocked_until: ["H-006 human go/no-go decision", "QRM-030 launch activation"],
    checks,
    benchmark_run_evidence: benchmarkRunEvidence(benchmarkRun, benchmarkScenarios),
    source_catalog_evidence: sourceCatalogEvidence(sourceCatalogCheck, sourceCatalog),
    workspace_checksum_sha256: workspaceResult.checksums.aggregateChecksumSha256
  };

  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, "launch-review-packet-v1.json"),
    `${JSON.stringify(packet, null, 2)}\n`
  );
  await writeFile(path.join(artifactDir, "launch-review-packet-v1.md"), renderMarkdown(packet));

  return packet;
}

async function checkedSourceCatalog(workspacePath: string, officialIndexHtml?: string) {
  try {
    const result = await verifyPaulGrahamSourceCatalog(workspacePath, officialIndexHtml);

    return { ok: true as const, result };
  } catch (error) {
    return {
      ok: false as const,
      error: errorMessage(error)
    };
  }
}

function sourceCatalogReadiness(
  check: Awaited<ReturnType<typeof checkedSourceCatalog>>
): LaunchReviewCheck {
  if (!check.ok) {
    return {
      key: "source_catalog_coverage",
      label: "Source Catalog Coverage",
      status: "blocked",
      summary: "Official essay-index verification could not complete.",
      evidence: { official_index_url: PAUL_GRAHAM_INDEX_URL, error: check.error },
      blockers: [check.error]
    };
  }

  const errors = check.result.errors;

  return {
    key: "source_catalog_coverage",
    label: "Source Catalog Coverage",
    status: errors.length === 0 ? "pass" : "fail",
    summary:
      errors.length === 0
        ? "Catalog coverage matches the official Paul Graham essay index."
        : "Catalog coverage does not match the official Paul Graham essay index.",
    evidence: {
      official_index_url: check.result.officialIndexUrl,
      official_essay_count: check.result.officialEssayCount,
      catalog_essay_count: check.result.catalogEssayCount,
      error_count: errors.length
    },
    blockers: errors
  };
}

function workspaceValidationReadiness(errors: Array<{ path: string; message: string }>): LaunchReviewCheck {
  return {
    key: "workspace_validation",
    label: "Workspace Validation",
    status: errors.length === 0 ? "pass" : "fail",
    summary: errors.length === 0 ? "Workspace validation passed." : "Workspace validation failed.",
    evidence: { error_count: errors.length },
    blockers: errors.map((error) => `${error.path}: ${error.message}`)
  };
}

function corpusReadiness(manifest: JsonObject): LaunchReviewCheck {
  const documents = arrayValue(manifest.documents).filter(isRecord);
  const fragments = documents.flatMap((document) => arrayValue(document.fragments).filter(isRecord));
  const approvedDocuments = documents.filter((document) => stringValue(document.document_state) === "approved");
  const approvedFragments = fragments.filter((fragment) => stringValue(fragment.fragment_state) === "approved");
  const embeddedFragments = fragments.filter(
    (fragment) =>
      numberValue(fragment.embedding_dimensions) === EMBEDDING_DIMENSIONS &&
      Boolean(stringValue(fragment.embedding_model))
  );
  const blockers: string[] = [];

  if (stringValue(manifest.advisor_slug) !== ADVISOR_SLUG) {
    blockers.push("corpus/manifest.json.advisor_slug must be paul-graham");
  }

  if (documents.length === 0 || fragments.length === 0) {
    blockers.push("corpus manifest must include source documents and fragments");
  }

  if (approvedDocuments.length !== documents.length) {
    blockers.push(
      `approved document eligibility is incomplete (${approvedDocuments.length}/${documents.length} approved)`
    );
  }

  if (approvedFragments.length !== fragments.length) {
    blockers.push(
      `approved fragment eligibility is incomplete (${approvedFragments.length}/${fragments.length} approved)`
    );
  }

  if (embeddedFragments.length !== fragments.length) {
    blockers.push(
      `fragment embedding evidence is incomplete (${embeddedFragments.length}/${fragments.length} embedded)`
    );
  }

  return {
    key: "corpus_profile_readiness",
    label: "Corpus/Profile Readiness",
    status: blockers.length === 0 ? "pass" : "fail",
    summary:
      blockers.length === 0
        ? "Corpus manifest has approved documents and embedded fragments."
        : "Corpus manifest is not approved-ready for launch.",
    evidence: {
      source_count: numberValue(manifest.source_count),
      document_count: documents.length,
      fragment_count: fragments.length,
      approved_document_count: approvedDocuments.length,
      approved_fragment_count: approvedFragments.length,
      embedded_fragment_count: embeddedFragments.length,
      embedding_dimensions: numberValue(manifest.embedding_dimensions),
      embedding_model: stringValue(manifest.embedding_model) ?? null
    },
    blockers
  };
}

function topicTagReadiness(topicTags: JsonObject): LaunchReviewCheck {
  const tags = arrayValue(topicTags.tags).filter(isRecord);
  const approvedTags = tags.filter((tag) => stringValue(tag.tag_state) === "approved");
  const embeddedTags = approvedTags.filter(
    (tag) =>
      arrayValue(tag.embedding).length === EMBEDDING_DIMENSIONS &&
      Boolean(stringValue(tag.embedding_model)) &&
      Boolean(stringValue(tag.approved_at))
  );
  const blockers: string[] = [];

  if (stringValue(topicTags.visibility) !== "internal_only") {
    blockers.push("topic-tags.json.visibility must be internal_only");
  }

  if (tags.length === 0) {
    blockers.push("topic-tags.json must contain topic tags");
  }

  if (approvedTags.length !== tags.length) {
    blockers.push(`approved topic-tag readiness is incomplete (${approvedTags.length}/${tags.length} approved)`);
  }

  if (embeddedTags.length !== approvedTags.length) {
    blockers.push(`approved topic-tag embeddings are incomplete (${embeddedTags.length}/${approvedTags.length})`);
  }

  return {
    key: "topic_tag_readiness",
    label: "Topic-Tag Readiness",
    status: blockers.length === 0 ? "pass" : "fail",
    summary:
      blockers.length === 0
        ? "Approved internal topic tags have embeddings."
        : "Topic tags are missing approval or embedding evidence.",
    evidence: {
      tag_count: tags.length,
      approved_tag_count: approvedTags.length,
      embedded_approved_tag_count: embeddedTags.length,
      visibility: stringValue(topicTags.visibility) ?? null
    },
    blockers
  };
}

function dossierReadiness(
  dossier: JsonObject,
  workspaceErrors: Array<{ path: string; message: string }>
): LaunchReviewCheck {
  const blockers: string[] = [];

  if (numberValue(dossier.version) !== 1) {
    blockers.push("dossier-v1.json.version must be 1");
  }

  if (arrayValue(dossier.red_lines).length === 0) {
    blockers.push("dossier-v1.json.red_lines must be present");
  }

  if (!isRecord(dossier.source_map)) {
    blockers.push("dossier-v1.json.source_map must be present");
  }

  const dossierErrors = workspaceErrors.filter((error) => error.path.startsWith("dossier-v1.json"));

  blockers.push(...dossierErrors.map((error) => `${error.path}: ${error.message}`));

  return {
    key: "dossier_readiness",
    label: "Dossier Readiness",
    status: blockers.length === 0 ? "pass" : "fail",
    summary:
      blockers.length === 0
        ? "Current dossier file is schema-valid and approval-ready."
        : "Dossier is not current/approval-ready.",
    evidence: {
      version: numberValue(dossier.version),
      red_line_count: arrayValue(dossier.red_lines).length,
      theme_count: arrayValue(dossier.themes).length,
      core_idea_count: arrayValue(dossier.core_ideas).length,
      quote_rule_count: arrayValue(dossier.quote_set).length
    },
    blockers
  };
}

function selectionProfileReadiness(
  selectionProfile: JsonObject,
  topicTags: JsonObject,
  dossier: JsonObject
): LaunchReviewCheck {
  const tagKeys = arrayValue(topicTags.tags)
    .filter(isRecord)
    .map((tag) => stringValue(tag.tag_key))
    .filter((tagKey): tagKey is string => Boolean(tagKey));
  const derivedFrom = isRecord(selectionProfile.derived_from) ? selectionProfile.derived_from : {};
  const derivedTagKeys = arrayValue(derivedFrom.topic_tag_keys)
    .map((tagKey) => (typeof tagKey === "string" ? tagKey : null))
    .filter((tagKey): tagKey is string => Boolean(tagKey));
  const blockers: string[] = [];

  if (arrayValue(selectionProfile.embedding).length !== EMBEDDING_DIMENSIONS) {
    blockers.push(`selection-profile-v1.json.embedding must contain ${EMBEDDING_DIMENSIONS} numbers`);
  }

  if (!stringValue(selectionProfile.embedding_model)) {
    blockers.push("selection-profile-v1.json.embedding_model must be present");
  }

  if (numberValue(derivedFrom.dossier_version) !== numberValue(dossier.version)) {
    blockers.push("selection profile dossier_version must match dossier-v1.json.version");
  }

  for (const tagKey of tagKeys) {
    if (!derivedTagKeys.includes(tagKey)) {
      blockers.push(`selection profile is missing topic tag ${tagKey}`);
    }
  }

  return {
    key: "selection_profile_readiness",
    label: "Selection-Profile Readiness",
    status: blockers.length === 0 ? "pass" : "fail",
    summary:
      blockers.length === 0
        ? "Selection profile is derived from current tags and dossier."
        : "Selection profile is not ready for specialist-fit selection.",
    evidence: {
      embedding_dimensions: arrayValue(selectionProfile.embedding).length,
      embedding_model: stringValue(selectionProfile.embedding_model) ?? null,
      derived_topic_tag_count: derivedTagKeys.length,
      current_topic_tag_count: tagKeys.length,
      dossier_version: numberValue(derivedFrom.dossier_version)
    },
    blockers
  };
}

function benchmarkScenarioReadiness(benchmarkScenarios: JsonObject, topicTags: JsonObject): LaunchReviewCheck {
  const scenarios = arrayValue(benchmarkScenarios.scenarios).filter(isRecord);
  const requiredLocales = isRecord(benchmarkScenarios.thresholds)
    ? arrayValue(benchmarkScenarios.thresholds.required_locales)
    : [];
  const tagKeys = new Set(
    arrayValue(topicTags.tags)
      .filter(isRecord)
      .map((tag) => stringValue(tag.tag_key))
      .filter((tagKey): tagKey is string => Boolean(tagKey))
  );
  const coveredTags = new Set<string>();
  const blockers: string[] = [];

  if (scenarios.length === 0) {
    blockers.push("benchmark-scenarios-v1.json.scenarios must be non-empty");
  }

  scenarios.forEach((scenario) => {
    const prompts = isRecord(scenario.prompts) ? scenario.prompts : {};

    for (const locale of requiredLocales) {
      if (typeof locale === "string" && !stringValue(prompts[locale])) {
        blockers.push(`scenario ${stringValue(scenario.id) ?? "(unknown)"} missing ${locale} prompt`);
      }
    }

    if (isRecord(scenario.coverage)) {
      for (const tagKey of arrayValue(scenario.coverage.topic_tag_keys)) {
        if (typeof tagKey === "string") {
          coveredTags.add(tagKey);
        }
      }
    }
  });

  for (const tagKey of tagKeys) {
    if (!coveredTags.has(tagKey)) {
      blockers.push(`benchmark scenarios do not cover topic tag ${tagKey}`);
    }
  }

  return {
    key: "benchmark_scenario_readiness",
    label: "Benchmark Scenario Readiness",
    status: blockers.length === 0 ? "pass" : "fail",
    summary:
      blockers.length === 0
        ? "Benchmark scenarios cover required locales and topic tags."
        : "Benchmark scenarios are missing required coverage.",
    evidence: {
      dataset_key: stringValue(benchmarkScenarios.dataset_key) ?? null,
      scenario_count: scenarios.length,
      required_locale_count: requiredLocales.length,
      covered_topic_tag_count: coveredTags.size,
      current_topic_tag_count: tagKeys.size
    },
    blockers
  };
}

function benchmarkRunReadiness(
  benchmarkRun: JsonObject | null,
  benchmarkScenarios: JsonObject
): LaunchReviewCheck {
  const expectedRuns = expectedBenchmarkAnswerCount(benchmarkScenarios);
  const expectedAnswerKeys = expectedBenchmarkAnswerKeys(benchmarkScenarios);

  if (!benchmarkRun) {
    return {
      key: "benchmark_run_evidence",
      label: "Benchmark Run Evidence",
      status: "fail",
      summary: "Paul Graham benchmark run evidence is missing.",
      evidence: {
        expected_answer_count: expectedRuns,
        artifact_path: "artifacts/paul-graham/benchmark-runs-v1.json"
      },
      blockers: ["Run and review Paul Graham benchmark answers before launch approval."]
    };
  }

  const answers = arrayValue(benchmarkRun.answers).filter(isRecord);
  const passed = booleanValue(benchmarkRun.passed);
  const modelName = stringValue(benchmarkRun.model_name);
  const blockers: string[] = [];

  if (stringValue(benchmarkRun.dataset_key) !== stringValue(benchmarkScenarios.dataset_key)) {
    blockers.push("benchmark run dataset_key does not match benchmark-scenarios-v1.json");
  }

  if (!modelName) {
    blockers.push("benchmark run model_name must be present");
  }

  if (answers.length < expectedRuns) {
    blockers.push(`benchmark run has ${answers.length}/${expectedRuns} expected answers`);
  }

  const backedAnswers = answers.filter(
    (answer) =>
      stringValue(answer.scenario_id) &&
      stringValue(answer.locale) &&
      stringValue(answer.prompt) &&
      stringValue(answer.answer_text) &&
      stringValue(answer.model_response_id)
  );

  if (backedAnswers.length !== answers.length) {
    blockers.push("benchmark run answers must include model-backed response evidence");
  }

  const answerKeys = new Set(
    backedAnswers.map((answer) => `${stringValue(answer.scenario_id)}:${stringValue(answer.locale)}`)
  );
  for (const expectedAnswerKey of expectedAnswerKeys) {
    if (!answerKeys.has(expectedAnswerKey)) {
      blockers.push(`benchmark run is missing answer for ${expectedAnswerKey}`);
    }
  }

  if (passed !== true) {
    blockers.push("benchmark run is not marked passed");
  }

  return {
    key: "benchmark_run_evidence",
    label: "Benchmark Run Evidence",
    status: blockers.length === 0 ? "pass" : "fail",
    summary:
      blockers.length === 0
        ? "Benchmark run evidence exists and is marked passed."
        : "Benchmark run evidence is incomplete or not passing.",
    evidence: {
      dataset_key: stringValue(benchmarkRun.dataset_key) ?? null,
      generated_at: stringValue(benchmarkRun.generated_at) ?? null,
      model_name: modelName ?? null,
      answer_count: answers.length,
      expected_answer_count: expectedRuns,
      passed
    },
    blockers
  };
}

function launchSafetyReadiness(advisor: JsonObject): LaunchReviewCheck {
  const blockers: string[] = [];

  if ("is_launch_enabled" in advisor) {
    blockers.push("advisor.json must not set is_launch_enabled");
  }

  if ("readiness_status" in advisor) {
    blockers.push("advisor.json must not set readiness_status");
  }

  if ("benchmark_passed_at" in advisor) {
    blockers.push("advisor.json must not set benchmark_passed_at");
  }

  return {
    key: "launch_safety",
    label: "Launch Safety",
    status: blockers.length === 0 ? "pass" : "fail",
    summary:
      blockers.length === 0
        ? "Packet generation does not launch-enable Paul Graham."
        : "Advisor workspace includes runtime launch fields.",
    evidence: {
      launch_blocked_until: ["H-006", "QRM-030"],
      advisor_file_launch_fields_present: blockers.length
    },
    blockers
  };
}

function benchmarkRunEvidence(benchmarkRun: JsonObject | null, benchmarkScenarios: JsonObject): JsonObject {
  return {
    dataset_key: stringValue(benchmarkScenarios.dataset_key) ?? null,
    expected_answer_count: expectedBenchmarkAnswerCount(benchmarkScenarios),
    artifact_present: benchmarkRun !== null,
    run_sha256: benchmarkRun ? checksumJson(benchmarkRun) : null,
    passed: benchmarkRun ? booleanValue(benchmarkRun.passed) : null
  };
}

function sourceCatalogEvidence(
  check: Awaited<ReturnType<typeof checkedSourceCatalog>>,
  sourceCatalog: JsonObject
): JsonObject {
  if (!check.ok) {
    return {
      official_index_url: PAUL_GRAHAM_INDEX_URL,
      catalog_source_count: arrayValue(sourceCatalog.sources).length,
      verification_error: check.error
    };
  }

  return {
    official_index_url: check.result.officialIndexUrl,
    official_essay_count: check.result.officialEssayCount,
    catalog_essay_count: check.result.catalogEssayCount,
    error_count: check.result.errors.length
  };
}

function expectedBenchmarkAnswerCount(benchmarkScenarios: JsonObject): number {
  const scenarios = arrayValue(benchmarkScenarios.scenarios).filter(isRecord);
  const thresholds = isRecord(benchmarkScenarios.thresholds) ? benchmarkScenarios.thresholds : {};
  const requiredLocales = arrayValue(thresholds.required_locales).filter(
    (locale) => typeof locale === "string"
  );

  return scenarios.length * Math.max(requiredLocales.length, 1);
}

function expectedBenchmarkAnswerKeys(benchmarkScenarios: JsonObject): string[] {
  const scenarios = arrayValue(benchmarkScenarios.scenarios).filter(isRecord);
  const thresholds = isRecord(benchmarkScenarios.thresholds) ? benchmarkScenarios.thresholds : {};
  const requiredLocales = arrayValue(thresholds.required_locales).filter(
    (locale): locale is string => typeof locale === "string"
  );

  return scenarios.flatMap((scenario) => {
    const scenarioId = stringValue(scenario.id);
    if (!scenarioId) {
      return [];
    }

    return requiredLocales.map((locale) => `${scenarioId}:${locale}`);
  });
}

function renderMarkdown(packet: PaulGrahamLaunchReviewPacket): string {
  const lines = [
    "# Paul Graham Launch Review Packet",
    "",
    `- Generated at: ${packet.generated_at}`,
    `- Recommendation: ${packet.recommendation}`,
    `- Official essay index: ${packet.official_index_url}`,
    `- Workspace checksum: ${packet.workspace_checksum_sha256 ?? "unavailable"}`,
    `- Launch blocked until: ${packet.launch_blocked_until.join("; ")}`,
    "",
    "## Readiness Checks",
    ""
  ];

  for (const check of packet.checks) {
    lines.push(`### ${check.label}`);
    lines.push(`- Status: ${check.status}`);
    lines.push(`- Summary: ${check.summary}`);
    lines.push(`- Evidence: ${JSON.stringify(check.evidence)}`);

    if (check.blockers.length > 0) {
      lines.push("- Blockers:");
      for (const blocker of check.blockers) {
        lines.push(`  - ${blocker}`);
      }
    } else {
      lines.push("- Blockers: none");
    }

    lines.push("");
  }

  lines.push("## Curator Decision");
  lines.push("");
  lines.push("- Human decision: pending");
  lines.push("- This packet does not set `is_launch_enabled`, `readiness_status`, or `benchmark_passed_at`.");
  lines.push("- Paul Graham remains blocked from public Telegram answers until H-006 and QRM-030.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isRecord(value)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }

  return value;
}

async function readOptionalJsonObject(filePath: string): Promise<JsonObject | null> {
  try {
    await stat(filePath);
  } catch {
    return null;
  }

  return await readJsonObject(filePath);
}

function checksumJson(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: JsonValue | unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberValue(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause;

  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }

  return error.message;
}
