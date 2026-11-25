import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ServerConfig } from "../config.ts";
import { postgrest } from "../supabase.ts";
import { UUID_RE, workspaceFragmentId, workspaceSourceId } from "./workspace-ids.ts";

const COMMAND_RE = /^[a-z0-9_]{1,32}$/;
const RESERVED_COMMANDS = new Set(["start", "all", "ask"]);
const REQUIRED_FILES = ["advisor.json", "source-catalog.json", "topic-tags.json"] as const;
const DOSSIER_RE = /^dossier-v(\d+)\.json$/;
const BENCHMARK_RE = /^benchmark-scenarios-v(\d+)\.json$/;
const SELECTION_PROFILE_RE = /^selection-profile-v(\d+)\.json$/;
const EMBEDDING_DIMENSIONS = 1536;
const TAG_KEY_RE = /^[a-z0-9_]+$/;
const BROAD_TOPIC_TAGS = new Set([
  "business",
  "startups",
  "writing",
  "technology",
  "venture_capital",
  "philosophy",
  "leadership",
  "ethics"
]);
const USER_PROBLEM_SHAPE_RE =
  /\b(question|decision|fundraising|writing|leadership pressure|product judgment|distress|anger|conflict|discipline|survival|runway|delegation|growth|users?|work|career|disagreement|social pressure|taste|design|programming|startup)\b/i;

type JsonObject = Record<string, unknown>;
type VersionedFile = { name: string; version: number };

export type AdvisorWorkspaceIssue = {
  path: string;
  message: string;
};

export type AdvisorWorkspaceChecksums = {
  inputFiles: Record<string, string>;
  corpusFiles: Record<string, string>;
  aggregateChecksumSha256: string;
};

export type AdvisorWorkspaceValidationResult = {
  workspacePath: string;
  advisorSlug: string;
  checksums: AdvisorWorkspaceChecksums;
  errors: AdvisorWorkspaceIssue[];
};

export type AdvisorWorkspacePublishPlan = {
  advisor: JsonObject;
  sources: JsonObject[];
  topicTags: JsonObject[];
  dossier: JsonObject;
  benchmarkScenarios: JsonObject;
  selectionProfile: JsonObject | null;
  checksums: AdvisorWorkspaceChecksums;
};

export type PublishedAdvisorWorkspace = AdvisorWorkspacePublishPlan & {
  advisorId: string;
  dossierId: string;
};

export class AdvisorWorkspaceValidationError extends Error {
  readonly errors: AdvisorWorkspaceIssue[];

  constructor(errors: AdvisorWorkspaceIssue[]) {
    super(errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
    this.name = "AdvisorWorkspaceValidationError";
    this.errors = errors;
  }
}

export async function validateAdvisorWorkspace(
  workspacePath: string,
  advisorsRoot = path.dirname(path.resolve(workspacePath))
): Promise<AdvisorWorkspaceValidationResult> {
  const workspace = await readWorkspace(workspacePath);

  return {
    workspacePath: workspace.path,
    advisorSlug: workspace.slug,
    checksums: workspace.checksums,
    errors: await validateWorkspace(workspace, advisorsRoot)
  };
}

export async function buildAdvisorWorkspacePublishPlan(
  workspacePath: string,
  advisorsRoot = path.dirname(path.resolve(workspacePath))
): Promise<AdvisorWorkspacePublishPlan> {
  const workspace = await readWorkspace(workspacePath);
  const errors = await validateWorkspace(workspace, advisorsRoot);

  if (errors.length > 0) {
    throw new AdvisorWorkspaceValidationError(errors);
  }

  const dossierFile = workspace.dossierFile;

  if (!dossierFile) {
    throw new AdvisorWorkspaceValidationError([
      { path: "dossier-v{n}.json", message: "required versioned workspace file is missing" }
    ]);
  }

  return {
    advisor: {
      slug: workspace.slug,
      telegram_command: requiredString(workspace.advisor, "telegram_command"),
      display_name: requiredString(workspace.advisor, "display_name"),
      short_bio: requiredString(workspace.advisor, "short_bio"),
      era_label: requiredString(workspace.advisor, "era_label"),
      domain_label: requiredString(workspace.advisor, "domain_label"),
      disclaimer_text: requiredString(workspace.advisor, "disclaimer_text"),
      supported_locales: requiredStringArray(workspace.advisor, "supported_locales")
    },
    sources: workspace.sources.map((source) => {
      const sourceKey = requiredString(source, "source_key");

      return {
        id: workspaceSourceId(workspace.slug, sourceKey),
        source_key: sourceKey,
        title: requiredString(source, "title"),
        creator: optionalString(source, "creator"),
        source_type: requiredString(source, "source_type"),
        origin_class: requiredString(source, "origin_class"),
        language_code: requiredString(source, "language_code"),
        access_model: requiredString(source, "access_model"),
        acquisition_status: optionalString(source, "acquisition_status") ?? "discovered",
        priority: optionalString(source, "priority") ?? "medium",
        provenance_url: optionalString(source, "provenance_url"),
        provenance_citation: optionalString(source, "provenance_citation"),
        storage_path: optionalString(source, "storage_path"),
        blocked_reason: optionalString(source, "blocked_reason"),
        curator_notes: optionalString(source, "curator_notes"),
        input_checksum_sha256: workspace.checksums.inputFiles["source-catalog.json"]
      };
    }),
    topicTags: workspace.topicTags.map((tag) => ({
      tag_key: requiredString(tag, "tag_key"),
      label: requiredString(tag, "label"),
      description: optionalString(tag, "description"),
      tag_state: optionalString(tag, "tag_state") ?? "pending",
      embedding: optionalNumberArray(tag, "embedding"),
      embedding_model: optionalString(tag, "embedding_model"),
      curator_notes: optionalString(tag, "curator_notes"),
      approved_at: optionalString(tag, "approved_at"),
      input_checksum_sha256:
        optionalString(tag, "input_checksum_sha256") ?? workspace.checksums.inputFiles["topic-tags.json"]
    })),
    dossier: {
      version: dossierFile.version,
      schema_version: optionalInteger(workspace.dossier, "schema_version") ?? 1,
      artifact_state: "pending",
      is_current: false,
      payload: workspace.dossier,
      input_checksum_sha256: workspace.checksums.inputFiles[dossierFile.name],
      approved_at: null
    },
    benchmarkScenarios: {
      version: optionalInteger(workspace.benchmarkFile.payload, "version") ?? 1,
      dataset_key: requiredString(workspace.benchmarkFile.payload, "dataset_key"),
      payload: workspace.benchmarkFile.payload,
      input_checksum_sha256: workspace.checksums.inputFiles[workspace.benchmarkFile.name]
    },
    selectionProfile: workspace.selectionProfileFile
      ? {
          profile_text_en: requiredString(workspace.selectionProfileFile.payload, "profile_text_en"),
          embedding: workspace.selectionProfileFile.payload.embedding,
          embedding_model: requiredString(workspace.selectionProfileFile.payload, "embedding_model"),
          input_checksum_sha256:
            optionalString(workspace.selectionProfileFile.payload, "input_checksum_sha256") ??
            workspace.checksums.inputFiles[workspace.selectionProfileFile.name]
        }
      : null,
    checksums: workspace.checksums
  };
}

export async function publishAdvisorWorkspace(
  config: ServerConfig,
  workspacePath: string,
  advisorsRoot = path.dirname(path.resolve(workspacePath))
): Promise<PublishedAdvisorWorkspace> {
  const plan = await buildAdvisorWorkspacePublishPlan(workspacePath, advisorsRoot);
  const [advisor] = await postgrest<{ id: string }[]>(config, {
    method: "POST",
    path: "rpc/quorum_publish_advisor_metadata",
    body: advisorMetadataRpcBody(plan.advisor)
  });

  if (!advisor) {
    throw new Error("Advisor workspace publish did not return an advisor row.");
  }

  await upsertRows(config, "advisor_sources", "advisor_id,source_key", withAdvisor(plan.sources, advisor.id));
  await upsertRows(config, "advisor_topic_tags", "advisor_id,tag_key", withAdvisor(plan.topicTags, advisor.id));

  const [dossier] = await postgrest<{ id: string }[]>(config, {
    method: "POST",
    path: "advisor_dossiers",
    query: { on_conflict: "advisor_id,version", select: "id" },
    body: [{ ...plan.dossier, advisor_id: advisor.id }],
    prefer: "return=representation,resolution=merge-duplicates"
  });

  if (!dossier) {
    throw new Error("Advisor workspace publish did not return a dossier row.");
  }

  if (plan.selectionProfile) {
    await upsertRows(config, "advisor_selection_profiles", "advisor_id", [
      { ...plan.selectionProfile, advisor_id: advisor.id, dossier_id: dossier.id }
    ]);
  }

  return { ...plan, advisorId: advisor.id, dossierId: dossier.id };
}

async function upsertRows(
  config: ServerConfig,
  table: string,
  conflictTarget: string,
  rows: JsonObject[]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await postgrest<unknown>(config, {
    method: "POST",
    path: table,
    query: { on_conflict: conflictTarget },
    body: rows,
    prefer: "return=minimal,resolution=merge-duplicates"
  });
}

function withAdvisor(rows: JsonObject[], advisorId: string): JsonObject[] {
  return rows.map((row) => ({ ...row, advisor_id: advisorId }));
}

function advisorMetadataRpcBody(advisor: JsonObject): JsonObject {
  return {
    p_slug: advisor.slug,
    p_telegram_command: advisor.telegram_command,
    p_display_name: advisor.display_name,
    p_short_bio: advisor.short_bio,
    p_era_label: advisor.era_label,
    p_domain_label: advisor.domain_label,
    p_disclaimer_text: advisor.disclaimer_text,
    p_supported_locales: advisor.supported_locales
  };
}

type Workspace = Awaited<ReturnType<typeof readWorkspace>>;

async function readWorkspace(workspacePath: string) {
  const absolutePath = path.resolve(workspacePath);
  const inputNames = await inputFileNames(absolutePath);
  const checksums = await computeChecksums(absolutePath, inputNames);
  const loadErrors: AdvisorWorkspaceIssue[] = [];
  const dossierFile = latestVersioned(inputNames, DOSSIER_RE);
  const benchmarkFile = latestVersioned(inputNames, BENCHMARK_RE);
  const selectionProfileFile = latestVersioned(inputNames, SELECTION_PROFILE_RE);

  return {
    path: absolutePath,
    slug: path.basename(absolutePath),
    inputNames,
    checksums,
    loadErrors,
    advisor: await readJson(absolutePath, "advisor.json", loadErrors),
    sourceCatalog: await readJson(absolutePath, "source-catalog.json", loadErrors),
    topicTagCatalog: await readJson(absolutePath, "topic-tags.json", loadErrors),
    dossierFile,
    dossier: dossierFile ? await readJson(absolutePath, dossierFile.name, loadErrors) : {},
    benchmarkFile: {
      name: benchmarkFile?.name ?? "benchmark-scenarios-v{n}.json",
      version: benchmarkFile?.version ?? 0,
      payload: benchmarkFile ? await readJson(absolutePath, benchmarkFile.name, loadErrors) : {}
    },
    corpusManifest: await readJsonIfExists(absolutePath, "corpus/manifest.json", loadErrors),
    selectionProfileFile: selectionProfileFile
      ? {
          name: selectionProfileFile.name,
          version: selectionProfileFile.version,
          payload: await readJson(absolutePath, selectionProfileFile.name, loadErrors)
        }
      : null,
    get sources() {
      return catalogRows(this.sourceCatalog, "sources");
    },
    get topicTags() {
      return catalogRows(this.topicTagCatalog, "tags");
    }
  };
}

async function validateWorkspace(
  workspace: Workspace,
  advisorsRoot: string
): Promise<AdvisorWorkspaceIssue[]> {
  const errors = [...workspace.loadErrors];

  for (const fileName of REQUIRED_FILES) {
    requireFile(workspace, fileName, errors);
  }

  requireVersioned(workspace, DOSSIER_RE, "dossier-v{n}.json", errors);
  requireVersioned(workspace, BENCHMARK_RE, "benchmark-scenarios-v{n}.json", errors);
  await requireCorpusDir(workspace, errors);
  validateAdvisor(workspace, errors);
  validateCatalogRows(
    "source-catalog.json.sources",
    catalogEntries(workspace.sourceCatalog, "sources"),
    "source_key",
    errors
  );
  validateCatalogRows(
    "topic-tags.json.tags",
    catalogEntries(workspace.topicTagCatalog, "tags"),
    "tag_key",
    errors
  );
  validateDossier(workspace, errors);
  validateBenchmark(workspace, errors);
  validateTopicTagApprovalReadiness(workspace, errors);
  validateSelectionProfile(workspace, errors);
  validateAdvisorReferenceBoundaries(workspace, errors);
  errors.push(...(await duplicateCommandErrors(workspace, advisorsRoot)));

  return errors;
}

function validateAdvisor(workspace: Workspace, errors: AdvisorWorkspaceIssue[]): void {
  for (const field of [
    "display_name",
    "telegram_command",
    "short_bio",
    "era_label",
    "domain_label",
    "disclaimer_text"
  ]) {
    requireString(workspace.advisor, `advisor.json.${field}`, field, errors);
  }

  const declaredSlug = optionalString(workspace.advisor, "slug");
  const command = optionalString(workspace.advisor, "telegram_command");

  if (declaredSlug && declaredSlug !== workspace.slug) {
    errors.push({ path: "advisor.json.slug", message: "slug must match workspace directory name" });
  }

  if (!isNonEmptyStringArray(workspace.advisor.supported_locales)) {
    errors.push({
      path: "advisor.json.supported_locales",
      message: "supported_locales must be a non-empty string array"
    });
  }

  if (command && !COMMAND_RE.test(command)) {
    errors.push({
      path: "advisor.json.telegram_command",
      message: "telegram_command must match ^[a-z0-9_]{1,32}$"
    });
  }

  if (command && RESERVED_COMMANDS.has(command)) {
    errors.push({ path: "advisor.json.telegram_command", message: "telegram_command is reserved" });
  }
}

function validateCatalogRows(
  pathPrefix: string,
  rows: unknown[],
  keyField: "source_key" | "tag_key",
  errors: AdvisorWorkspaceIssue[]
): void {
  if (rows.length === 0) {
    errors.push({ path: pathPrefix.split(".")[0], message: "catalog must contain at least one row" });
    return;
  }

  const seen = new Set<string>();

  rows.forEach((row, index) => {
    if (!isObject(row)) {
      errors.push({ path: `${pathPrefix}[${index}]`, message: "catalog row must be an object" });
      return;
    }

    requireString(row, `${pathPrefix}[${index}].${keyField}`, keyField, errors);
    requireString(row, `${pathPrefix}[${index}].${keyField === "source_key" ? "title" : "label"}`, keyField === "source_key" ? "title" : "label", errors);

    if (keyField === "source_key") {
      for (const field of ["source_type", "origin_class", "language_code", "access_model"]) {
        requireString(row, `${pathPrefix}[${index}].${field}`, field, errors);
      }
    } else {
      const tagKey = optionalString(row, "tag_key");

      if (tagKey && !TAG_KEY_RE.test(tagKey)) {
        errors.push({
          path: `${pathPrefix}[${index}].tag_key`,
          message: "tag_key must be a stable lowercase snake_case key"
        });
      }

      requireString(row, `${pathPrefix}[${index}].description`, "description", errors);
    }

    const key = optionalString(row, keyField);

    if (key && seen.has(key)) {
      errors.push({ path: `${pathPrefix}[${index}].${keyField}`, message: `${keyField} is duplicated` });
    }

    seen.add(key ?? "");
  });
}

function validateDossier(workspace: Workspace, errors: AdvisorWorkspaceIssue[]): void {
  if (!workspace.dossierFile) {
    return;
  }

  if (
    optionalInteger(workspace.dossier, "version") !== null &&
    optionalInteger(workspace.dossier, "version") !== workspace.dossierFile.version
  ) {
    errors.push({
      path: `${workspace.dossierFile.name}.version`,
      message: "version must match the file name"
    });
  }

  for (const field of [
    "themes",
    "core_ideas",
    "argument_patterns",
    "quote_set",
    "red_lines",
    "secondary_context_notes"
  ]) {
    if (!Array.isArray(workspace.dossier[field])) {
      errors.push({ path: `${workspace.dossierFile.name}.${field}`, message: `${field} must be an array` });
    }
  }

  for (const field of ["tone", "source_map"]) {
    if (!isObject(workspace.dossier[field])) {
      errors.push({ path: `${workspace.dossierFile.name}.${field}`, message: `${field} must be an object` });
    }
  }

  validateDossierPayloadSchema(workspace, errors);
}

function validateDossierPayloadSchema(workspace: Workspace, errors: AdvisorWorkspaceIssue[]): void {
  const fileName = workspace.dossierFile?.name ?? "dossier-v{n}.json";

  validateDossierFragmentIdRows(workspace.dossier.themes, `${fileName}.themes`, errors);
  validateDossierFragmentIdRows(workspace.dossier.core_ideas, `${fileName}.core_ideas`, errors);
  validateDossierFragmentIdRows(
    workspace.dossier.argument_patterns,
    `${fileName}.argument_patterns`,
    errors
  );
  validateQuoteSet(workspace.dossier.quote_set, `${fileName}.quote_set`, errors);
  validateSecondaryContextNotes(
    workspace.dossier.secondary_context_notes,
    `${fileName}.secondary_context_notes`,
    errors
  );
  validateDossierSourceMap(workspace.dossier.source_map, `${fileName}.source_map`, errors);
}

function validateDossierFragmentIdRows(
  rows: unknown,
  pathPrefix: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (!Array.isArray(rows)) {
    return;
  }

  rows.forEach((row, index) => {
    if (!isObject(row)) {
      return;
    }

    rejectField(row, "fragment_refs", `${pathPrefix}[${index}].fragment_refs`, "use fragment_ids", errors);
    validateUuidArray(row, "fragment_ids", `${pathPrefix}[${index}].fragment_ids`, errors);
  });
}

function validateQuoteSet(
  rows: unknown,
  pathPrefix: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (!Array.isArray(rows)) {
    return;
  }

  rows.forEach((row, index) => {
    if (!isObject(row)) {
      return;
    }

    for (const field of ["source_key", "document_kind", "fragment_index"]) {
      rejectField(row, field, `${pathPrefix}[${index}].${field}`, "use fragment_id", errors);
    }

    validateUuidString(row, "fragment_id", `${pathPrefix}[${index}].fragment_id`, errors);
    requireString(row, `${pathPrefix}[${index}].label`, "label", errors);
    requireString(row, `${pathPrefix}[${index}].quote_text`, "quote_text", errors);
  });
}

function validateSecondaryContextNotes(
  rows: unknown,
  pathPrefix: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (!Array.isArray(rows)) {
    return;
  }

  rows.forEach((row, index) => {
    if (!isObject(row)) {
      return;
    }

    rejectField(row, "source_key", `${pathPrefix}[${index}].source_key`, "use source_id", errors);
    validateUuidString(row, "source_id", `${pathPrefix}[${index}].source_id`, errors);
    requireString(row, `${pathPrefix}[${index}].note`, "note", errors);
  });
}

function validateDossierSourceMap(
  value: unknown,
  pathPrefix: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (!isObject(value)) {
    return;
  }

  rejectField(value, "primary_source_keys", `${pathPrefix}.primary_source_keys`, "use primary_source_ids", errors);
  rejectField(
    value,
    "secondary_source_keys",
    `${pathPrefix}.secondary_source_keys`,
    "use secondary_source_ids",
    errors
  );
  validateUuidArray(value, "primary_source_ids", `${pathPrefix}.primary_source_ids`, errors);
  validateUuidArray(value, "secondary_source_ids", `${pathPrefix}.secondary_source_ids`, errors);
}

function rejectField(
  row: JsonObject,
  field: string,
  pathName: string,
  replacement: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (field in row) {
    errors.push({
      path: pathName,
      message: `${field} is not part of advisor_dossiers.payload schema v1; ${replacement}`
    });
  }
}

function validateUuidString(
  row: JsonObject,
  field: string,
  pathName: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  const value = row[field];

  if (typeof value !== "string" || !UUID_RE.test(value)) {
    errors.push({ path: pathName, message: `${field} must be a UUID string` });
  }
}

function validateUuidArray(
  row: JsonObject,
  field: string,
  pathName: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  const values = row[field];

  if (!Array.isArray(values)) {
    errors.push({ path: pathName, message: `${field} must be an array of UUID strings` });
    return;
  }

  values.forEach((value, index) => {
    if (typeof value !== "string" || !UUID_RE.test(value)) {
      errors.push({ path: `${pathName}[${index}]`, message: `${field} must contain only UUID strings` });
    }
  });
}

function validateBenchmark(workspace: Workspace, errors: AdvisorWorkspaceIssue[]): void {
  if (workspace.benchmarkFile.version === 0) {
    return;
  }

  requireString(
    workspace.benchmarkFile.payload,
    `${workspace.benchmarkFile.name}.dataset_key`,
    "dataset_key",
    errors
  );

  const scenarios = workspace.benchmarkFile.payload.scenarios;

  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    errors.push({ path: `${workspace.benchmarkFile.name}.scenarios`, message: "scenarios must be a non-empty array" });
    return;
  }

  const requiredLocales = stringArray(workspace.benchmarkFile.payload.thresholds, "required_locales");
  const topicTagKeys = new Set(workspace.topicTags.flatMap((tag) => {
    const tagKey = optionalString(tag, "tag_key");

    return tagKey ? [tagKey] : [];
  }));
  const coveredTagKeys = new Set<string>();

  scenarios.forEach((scenario, index) => {
    if (!isObject(scenario)) {
      errors.push({ path: `${workspace.benchmarkFile.name}.scenarios[${index}]`, message: "scenario must be an object" });
      return;
    }

    requireString(scenario, `${workspace.benchmarkFile.name}.scenarios[${index}].id`, "id", errors);
    requireString(scenario, `${workspace.benchmarkFile.name}.scenarios[${index}].retrieval_query_en`, "retrieval_query_en", errors);

    if (!Array.isArray(scenario.objectives) || scenario.objectives.length === 0) {
      errors.push({
        path: `${workspace.benchmarkFile.name}.scenarios[${index}].objectives`,
        message: "objectives must be a non-empty array"
      });
    }

    const prompts = scenario.prompts;

    if (!isObject(prompts)) {
      errors.push({ path: `${workspace.benchmarkFile.name}.scenarios[${index}].prompts`, message: "prompts must be an object" });
    } else {
      for (const locale of requiredLocales) {
        requireString(prompts, `${workspace.benchmarkFile.name}.scenarios[${index}].prompts.${locale}`, locale, errors);
      }
    }

    const coverage = isObject(scenario.coverage) ? scenario.coverage : null;
    const covered = coverage ? stringArray(coverage, "topic_tag_keys") : [];

    for (const tagKey of covered) {
      if (!topicTagKeys.has(tagKey)) {
        errors.push({
          path: `${workspace.benchmarkFile.name}.scenarios[${index}].coverage.topic_tag_keys`,
          message: `unknown topic tag key ${tagKey}`
        });
      }

      coveredTagKeys.add(tagKey);
    }
  });

  if (workspace.selectionProfileFile) {
    for (const tagKey of topicTagKeys) {
      if (!coveredTagKeys.has(tagKey)) {
        errors.push({
          path: `${workspace.benchmarkFile.name}.scenarios`,
          message: `topic tag ${tagKey} is not covered by benchmark scenarios`
        });
      }
    }
  }
}

function validateTopicTagApprovalReadiness(
  workspace: Workspace,
  errors: AdvisorWorkspaceIssue[]
): void {
  workspace.topicTags.forEach((tag, index) => {
    const pathPrefix = `topic-tags.json.tags[${index}]`;
    const publicationFields = [
      "bot_copy",
      "public_copy",
      "publication_path",
      "user_visible",
      "user_facing"
    ];

    for (const field of publicationFields) {
      if (field in tag) {
        errors.push({ path: `${pathPrefix}.${field}`, message: "topic tags are internal-only metadata" });
      }
    }

    validateOptionalEmbedding(tag, pathPrefix, errors);
    validateOptionalChecksum(tag, `${pathPrefix}.input_checksum_sha256`, "input_checksum_sha256", errors);

    if (optionalString(tag, "tag_state") === "approved") {
      requireString(tag, `${pathPrefix}.approved_at`, "approved_at", errors);
      requireString(tag, `${pathPrefix}.embedding_model`, "embedding_model", errors);
      validateApprovedTopicTagSelectionQuality(tag, pathPrefix, errors);

      if (!isEmbedding(tag.embedding)) {
        errors.push({
          path: `${pathPrefix}.embedding`,
          message: `embedding must contain ${EMBEDDING_DIMENSIONS} numbers for approved tags`
        });
      }
    }
  });
}

function validateApprovedTopicTagSelectionQuality(
  tag: JsonObject,
  pathPrefix: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  const tagKey = optionalString(tag, "tag_key");
  const label = optionalString(tag, "label");
  const description = optionalString(tag, "description");

  if (
    (tagKey && BROAD_TOPIC_TAGS.has(normalizeTopicName(tagKey))) ||
    (label && BROAD_TOPIC_TAGS.has(normalizeTopicName(label)))
  ) {
    errors.push({
      path: `${pathPrefix}.tag_key`,
      message: "approved topic tag is too broad for advisor selection routing"
    });
  }

  if (description && !USER_PROBLEM_SHAPE_RE.test(description)) {
    errors.push({
      path: `${pathPrefix}.description`,
      message: "approved topic tag description must name the user problem shape"
    });
  }

  if (!Array.isArray(tag.source_refs) || tag.source_refs.length === 0) {
    errors.push({
      path: `${pathPrefix}.source_refs`,
      message: "approved topic tags must include source_refs"
    });
  }
}

function validateSelectionProfile(workspace: Workspace, errors: AdvisorWorkspaceIssue[]): void {
  const selectionProfile = workspace.selectionProfileFile;

  if (!selectionProfile) {
    return;
  }

  const pathPrefix = selectionProfile.name;

  requireString(selectionProfile.payload, `${pathPrefix}.profile_text_en`, "profile_text_en", errors);
  requireString(selectionProfile.payload, `${pathPrefix}.embedding_model`, "embedding_model", errors);
  validateOptionalChecksum(
    selectionProfile.payload,
    `${pathPrefix}.input_checksum_sha256`,
    "input_checksum_sha256",
    errors
  );

  if (!isEmbedding(selectionProfile.payload.embedding)) {
    errors.push({
      path: `${pathPrefix}.embedding`,
      message: `embedding must contain ${EMBEDDING_DIMENSIONS} numbers`
    });
  }

  const derivedFrom = isObject(selectionProfile.payload.derived_from)
    ? selectionProfile.payload.derived_from
    : null;

  if (!derivedFrom) {
    errors.push({ path: `${pathPrefix}.derived_from`, message: "derived_from must be an object" });
    return;
  }

  const dossierVersion = optionalInteger(derivedFrom, "dossier_version");

  if (workspace.dossierFile && dossierVersion !== workspace.dossierFile.version) {
    errors.push({
      path: `${pathPrefix}.derived_from.dossier_version`,
      message: "dossier_version must match current dossier file version"
    });
  }

  const tagKeys = new Set(workspace.topicTags.flatMap((tag) => {
    const tagKey = optionalString(tag, "tag_key");

    return tagKey ? [tagKey] : [];
  }));
  const tagChecksums = new Map(
    workspace.topicTags.flatMap((tag) => {
      const tagKey = optionalString(tag, "tag_key");
      const checksum = optionalString(tag, "input_checksum_sha256");

      return tagKey && checksum ? [[tagKey, checksum] as const] : [];
    })
  );
  const derivedTagKeys = stringArray(derivedFrom, "topic_tag_keys");
  const derivedChecksums = isObject(derivedFrom.topic_tag_input_checksums)
    ? derivedFrom.topic_tag_input_checksums
    : null;

  for (const tagKey of derivedTagKeys) {
    if (!tagKeys.has(tagKey)) {
      errors.push({
        path: `${pathPrefix}.derived_from.topic_tag_keys`,
        message: `unknown topic tag key ${tagKey}`
      });
    }

    const expectedChecksum = tagChecksums.get(tagKey);
    const actualChecksum = derivedChecksums?.[tagKey];

    if (derivedChecksums && expectedChecksum && actualChecksum !== expectedChecksum) {
      errors.push({
        path: `${pathPrefix}.derived_from.topic_tag_input_checksums.${tagKey}`,
        message: "topic tag checksum must match topic-tags.json"
      });
    }
  }

  for (const tagKey of tagKeys) {
    if (!derivedTagKeys.includes(tagKey)) {
      errors.push({
        path: `${pathPrefix}.derived_from.topic_tag_keys`,
        message: `selection profile is missing topic tag ${tagKey}`
      });
    }
  }
}

function normalizeTopicName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function validateAdvisorReferenceBoundaries(
  workspace: Workspace,
  errors: AdvisorWorkspaceIssue[]
): void {
  const sourceKeys = new Set(workspace.sources.flatMap((source) => {
    const sourceKey = optionalString(source, "source_key");

    return sourceKey ? [sourceKey] : [];
  }));
  const sourceIds = new Set([...sourceKeys].map((sourceKey) => workspaceSourceId(workspace.slug, sourceKey)));
  const manifest = workspace.corpusManifest;
  const fragmentRefs = new Set<string>();
  const fragmentIds = new Set<string>();

  if (isObject(manifest)) {
    if (optionalString(manifest, "advisor_slug") && optionalString(manifest, "advisor_slug") !== workspace.slug) {
      errors.push({
        path: "corpus/manifest.json.advisor_slug",
        message: "corpus manifest advisor_slug must match workspace directory name"
      });
    }

    const documents = Array.isArray(manifest.documents) ? manifest.documents : [];

    documents.forEach((document) => {
      if (!isObject(document)) {
        return;
      }

      const sourceKey = optionalString(document, "source_key");
      const fragments = Array.isArray(document.fragments) ? document.fragments : [];

      if (sourceKey && !sourceKeys.has(sourceKey)) {
        errors.push({
          path: "corpus/manifest.json.documents",
          message: `manifest document source_key ${sourceKey} is not in source-catalog.json`
        });
      }

      fragments.forEach((fragment) => {
        if (!isObject(fragment) || !sourceKey) {
          return;
        }

        const fragmentIndex = optionalInteger(fragment, "fragment_index");

        if (fragmentIndex !== null) {
          fragmentRefs.add(`${sourceKey}:${fragmentIndex}`);
          fragmentIds.add(workspaceFragmentId(workspace.slug, sourceKey, fragmentIndex));
        }
      });
    });
  }

  validateSourceIdList(workspace.dossier.source_map, "primary_source_ids", sourceIds, workspace, errors);
  validateSourceIdList(workspace.dossier.source_map, "secondary_source_ids", sourceIds, workspace, errors);
  validateDossierSourceReferences(workspace, sourceIds, fragmentIds, errors);
  validateNestedLegacyReferences(
    workspace.dossier,
    workspace.dossierFile?.name ?? "dossier-v{n}.json",
    sourceKeys,
    fragmentRefs,
    errors
  );
}

function validateSourceIdList(
  value: unknown,
  field: "primary_source_ids" | "secondary_source_ids",
  sourceIds: Set<string>,
  workspace: Workspace,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (!isObject(value)) {
    return;
  }

  const ids = value[field];

  if (ids === undefined) {
    return;
  }

  if (!Array.isArray(ids)) {
    errors.push({
      path: `${workspace.dossierFile?.name ?? "dossier-v{n}.json"}.source_map.${field}`,
      message: `${field} must be an array`
    });
    return;
  }

  ids.forEach((id, index) => {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      errors.push({
        path: `${workspace.dossierFile?.name ?? "dossier-v{n}.json"}.source_map.${field}[${index}]`,
        message: "source id must be a UUID string"
      });
      return;
    }

    if (!sourceIds.has(id)) {
      errors.push({
        path: `${workspace.dossierFile?.name ?? "dossier-v{n}.json"}.source_map.${field}[${index}]`,
        message: `source_id ${id} is not in source-catalog.json`
      });
    }
  });
}

function validateDossierSourceReferences(
  workspace: Workspace,
  sourceIds: Set<string>,
  fragmentIds: Set<string>,
  errors: AdvisorWorkspaceIssue[]
): void {
  const fileName = workspace.dossierFile?.name ?? "dossier-v{n}.json";

  validateFragmentIdRows(workspace.dossier.themes, `${fileName}.themes`, fragmentIds, errors);
  validateFragmentIdRows(workspace.dossier.core_ideas, `${fileName}.core_ideas`, fragmentIds, errors);
  validateFragmentIdRows(workspace.dossier.argument_patterns, `${fileName}.argument_patterns`, fragmentIds, errors);
  validateQuoteFragmentIds(workspace.dossier.quote_set, `${fileName}.quote_set`, fragmentIds, errors);
  validateContextSourceIds(
    workspace.dossier.secondary_context_notes,
    `${fileName}.secondary_context_notes`,
    sourceIds,
    errors
  );
}

function validateFragmentIdRows(
  rows: unknown,
  pathPrefix: string,
  fragmentIds: Set<string>,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (!Array.isArray(rows)) {
    return;
  }

  rows.forEach((row, index) => {
    if (!isObject(row) || !Array.isArray(row.fragment_ids)) {
      return;
    }

    row.fragment_ids.forEach((fragmentId, fragmentIndex) => {
      if (typeof fragmentId === "string" && UUID_RE.test(fragmentId) && !fragmentIds.has(fragmentId)) {
        errors.push({
          path: `${pathPrefix}[${index}].fragment_ids[${fragmentIndex}]`,
          message: `fragment_id ${fragmentId} is not in corpus/manifest.json`
        });
      }
    });
  });
}

function validateQuoteFragmentIds(
  rows: unknown,
  pathPrefix: string,
  fragmentIds: Set<string>,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (!Array.isArray(rows)) {
    return;
  }

  rows.forEach((row, index) => {
    if (!isObject(row)) {
      return;
    }

    const fragmentId = optionalString(row, "fragment_id");

    if (fragmentId && UUID_RE.test(fragmentId) && !fragmentIds.has(fragmentId)) {
      errors.push({
        path: `${pathPrefix}[${index}].fragment_id`,
        message: `fragment_id ${fragmentId} is not in corpus/manifest.json`
      });
    }
  });
}

function validateContextSourceIds(
  rows: unknown,
  pathPrefix: string,
  sourceIds: Set<string>,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (!Array.isArray(rows)) {
    return;
  }

  rows.forEach((row, index) => {
    if (!isObject(row)) {
      return;
    }

    const sourceId = optionalString(row, "source_id");

    if (sourceId && UUID_RE.test(sourceId) && !sourceIds.has(sourceId)) {
      errors.push({
        path: `${pathPrefix}[${index}].source_id`,
        message: `source_id ${sourceId} is not in source-catalog.json`
      });
    }
  });
}

function validateNestedLegacyReferences(
  value: unknown,
  pathPrefix: string,
  sourceKeys: Set<string>,
  fragmentRefs: Set<string>,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateNestedLegacyReferences(item, `${pathPrefix}[${index}]`, sourceKeys, fragmentRefs, errors);
    });
    return;
  }

  if (!isObject(value)) {
    return;
  }

  const sourceKey = optionalString(value, "source_key");
  const fragmentIndex = optionalInteger(value, "fragment_index");

  if (sourceKey && !sourceKeys.has(sourceKey)) {
    errors.push({ path: `${pathPrefix}.source_key`, message: `source_key ${sourceKey} is not in source-catalog.json` });
  }

  if (sourceKey && fragmentIndex !== null && fragmentRefs.size > 0 && !fragmentRefs.has(`${sourceKey}:${fragmentIndex}`)) {
    errors.push({
      path: `${pathPrefix}.fragment_index`,
      message: `fragment ${sourceKey}:${fragmentIndex} is not in corpus/manifest.json`
    });
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    validateNestedLegacyReferences(nestedValue, `${pathPrefix}.${key}`, sourceKeys, fragmentRefs, errors);
  }
}

async function duplicateCommandErrors(
  workspace: Workspace,
  advisorsRoot: string
): Promise<AdvisorWorkspaceIssue[]> {
  const command = optionalString(workspace.advisor, "telegram_command");

  if (!command) {
    return [];
  }

  let entries;

  try {
    entries = await readdir(advisorsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const siblingPath = path.join(advisorsRoot, entry.name);

    if (!entry.isDirectory() || path.resolve(siblingPath) === workspace.path) {
      continue;
    }

    try {
      const sibling = JSON.parse(await readFile(path.join(siblingPath, "advisor.json"), "utf8")) as unknown;

      if (isObject(sibling) && sibling.telegram_command === command) {
        return [
          {
            path: "advisor.json.telegram_command",
            message: `telegram_command duplicates ${entry.name}`
          }
        ];
      }
    } catch {
      continue;
    }
  }

  return [];
}

async function inputFileNames(workspacePath: string): Promise<string[]> {
  try {
    return (await readdir(workspacePath))
      .filter(
        (name) =>
          REQUIRED_FILES.includes(name as (typeof REQUIRED_FILES)[number]) ||
          DOSSIER_RE.test(name) ||
          BENCHMARK_RE.test(name) ||
          SELECTION_PROFILE_RE.test(name)
      )
      .sort();
  } catch {
    return [];
  }
}

async function computeChecksums(
  workspacePath: string,
  inputNames: string[]
): Promise<AdvisorWorkspaceChecksums> {
  const inputFiles = await checksumsFor(workspacePath, inputNames);
  const corpusFiles = await checksumsFor(workspacePath, await corpusFileNames(workspacePath));
  const aggregate = createHash("sha256");

  for (const [name, checksum] of Object.entries({ ...inputFiles, ...corpusFiles }).sort()) {
    aggregate.update(`${name}\0${checksum}\n`);
  }

  return { inputFiles, corpusFiles, aggregateChecksumSha256: aggregate.digest("hex") };
}

async function corpusFileNames(workspacePath: string, relativeDir = "corpus"): Promise<string[]> {
  const dir = path.join(workspacePath, relativeDir);

  try {
    const children = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      children
        .filter((child) => !child.name.startsWith("."))
        .map((child) => {
          const relativePath = `${relativeDir}/${child.name}`;

          if (child.isDirectory()) {
            return corpusFileNames(workspacePath, relativePath);
          }

          return Promise.resolve(child.isFile() ? [relativePath] : []);
        })
    );

    return nested.flat().sort();
  } catch {
    return [];
  }
}

async function checksumsFor(workspacePath: string, relativePaths: string[]): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};

  for (const relativePath of relativePaths) {
    checksums[relativePath] = createHash("sha256")
      .update(await readFile(path.join(workspacePath, relativePath)))
      .digest("hex");
  }

  return checksums;
}

async function readJson(
  workspacePath: string,
  fileName: string,
  errors: AdvisorWorkspaceIssue[]
): Promise<JsonObject> {
  try {
    const contents = await readFile(path.join(workspacePath, fileName), "utf8");

    if (contents.trim() === "") {
      errors.push({ path: fileName, message: "JSON file must not be empty" });
      return {};
    }

    const value = JSON.parse(contents) as unknown;

    if (!isObject(value)) {
      errors.push({ path: fileName, message: "JSON file must contain an object" });
      return {};
    }

    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push({ path: fileName, message: "JSON file is malformed" });
    }

    return {};
  }
}

async function readJsonIfExists(
  workspacePath: string,
  fileName: string,
  errors: AdvisorWorkspaceIssue[]
): Promise<JsonObject | null> {
  try {
    return await readJson(workspacePath, fileName, errors);
  } catch {
    return null;
  }
}

function catalogRows(catalog: JsonObject, key: "sources" | "tags"): JsonObject[] {
  return catalogEntries(catalog, key).filter(isObject);
}

function catalogEntries(catalog: JsonObject, key: "sources" | "tags"): unknown[] {
  const rows = catalog[key];

  return Array.isArray(rows) ? rows : [];
}

function latestVersioned(names: string[], pattern: RegExp): VersionedFile | null {
  const files = names.flatMap((name) => {
    const match = pattern.exec(name);
    return match ? [{ name, version: Number(match[1]) }] : [];
  });

  return files.sort((left, right) => right.version - left.version)[0] ?? null;
}

function requireFile(workspace: Workspace, fileName: string, errors: AdvisorWorkspaceIssue[]): void {
  if (!workspace.checksums.inputFiles[fileName]) {
    errors.push({ path: fileName, message: "required workspace file is missing" });
  }
}

function requireVersioned(
  workspace: Workspace,
  pattern: RegExp,
  displayName: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (!workspace.inputNames.some((name) => pattern.test(name))) {
    errors.push({ path: displayName, message: "required versioned workspace file is missing" });
  }
}

async function requireCorpusDir(workspace: Workspace, errors: AdvisorWorkspaceIssue[]): Promise<void> {
  try {
    if ((await stat(path.join(workspace.path, "corpus"))).isDirectory()) {
      return;
    }
  } catch {
    // Report below.
  }

  errors.push({ path: "corpus/", message: "required corpus directory is missing" });
}

function requireString(
  row: JsonObject,
  pathName: string,
  field: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  if (!optionalString(row, field)) {
    errors.push({ path: pathName, message: `${field} must be a non-empty string` });
  }
}

function requiredString(row: JsonObject, field: string): string {
  const value = optionalString(row, field);

  if (!value) {
    throw new Error(`${field} is required.`);
  }

  return value;
}

function requiredStringArray(row: JsonObject, field: string): string[] {
  const value = row[field];

  if (!isNonEmptyStringArray(value)) {
    throw new Error(`${field} must be a non-empty string array.`);
  }

  return value;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item !== "");
}

function optionalString(row: JsonObject, field: string): string | null {
  const value = row[field];

  return typeof value === "string" && value !== "" ? value : null;
}

function optionalInteger(row: JsonObject, field: string): number | null {
  const value = row[field];

  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function optionalNumberArray(row: JsonObject, field: string): number[] | null {
  const value = row[field];

  return Array.isArray(value) && value.every((item) => typeof item === "number") ? value : null;
}

function stringArray(row: unknown, field: string): string[] {
  if (!isObject(row)) {
    return [];
  }

  const value = row[field];

  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "")
    ? value
    : [];
}

function validateOptionalEmbedding(
  row: JsonObject,
  pathPrefix: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  const hasEmbedding = "embedding" in row;
  const hasEmbeddingModel = "embedding_model" in row;

  if (hasEmbedding || hasEmbeddingModel) {
    requireString(row, `${pathPrefix}.embedding_model`, "embedding_model", errors);
  }

  if (hasEmbedding && !isEmbedding(row.embedding)) {
    errors.push({
      path: `${pathPrefix}.embedding`,
      message: `embedding must contain ${EMBEDDING_DIMENSIONS} numbers`
    });
  }
}

function validateOptionalChecksum(
  row: JsonObject,
  pathName: string,
  field: string,
  errors: AdvisorWorkspaceIssue[]
): void {
  const checksum = optionalString(row, field);

  if (checksum && !/^[0-9a-f]{64}$/.test(checksum)) {
    errors.push({ path: pathName, message: `${field} must be a lowercase SHA-256 checksum` });
  }
}

function isEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
