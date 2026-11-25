import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { generatePaulGrahamLaunchReviewPacket } from "../../../lib/server/advisors/paul-graham-launch-review.ts";
import { workspaceFragmentId, workspaceSourceId } from "../../../lib/server/advisors/workspace-ids.ts";

const EMBEDDING = Array.from({ length: 1536 }, () => 0.01);

test("generates a no-go packet when benchmark evidence is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-029-packet-"));
  const workspacePath = path.join(root, "paul-graham");
  const artifactDir = path.join(root, "artifacts", "paul-graham");

  await writeReadyWorkspace(workspacePath);

  const packet = await generatePaulGrahamLaunchReviewPacket({
    workspacePath,
    artifactDir,
    officialIndexHtml: '<html><body><a href="greatwork.html">How to Do Great Work</a></body></html>',
    generatedAt: "2026-04-29T00:00:00.000Z"
  });

  assert.equal(packet.recommendation, "no_go");
  assert.equal(checkStatus(packet, "source_catalog_coverage"), "pass");
  assert.equal(checkStatus(packet, "corpus_profile_readiness"), "pass");
  assert.equal(checkStatus(packet, "benchmark_run_evidence"), "fail");
  assert.ok(packet.launch_blocked_until.includes("H-006 human go/no-go decision"));

  const markdown = await readFile(path.join(artifactDir, "launch-review-packet-v1.md"), "utf8");
  const json = JSON.parse(
    await readFile(path.join(artifactDir, "launch-review-packet-v1.json"), "utf8")
  ) as { recommendation: string };

  assert.match(markdown, /Paul Graham remains blocked from public Telegram answers/);
  assert.equal(json.recommendation, "no_go");

  await rm(root, { recursive: true, force: true });
});

test("generates a go-ready packet with complete model-backed benchmark evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-042-packet-"));
  const workspacePath = path.join(root, "paul-graham");
  const artifactDir = path.join(root, "artifacts", "paul-graham");

  await writeReadyWorkspace(workspacePath);
  await writeBenchmarkRun(artifactDir);

  const packet = await generatePaulGrahamLaunchReviewPacket({
    workspacePath,
    artifactDir,
    officialIndexHtml: '<html><body><a href="greatwork.html">How to Do Great Work</a></body></html>',
    generatedAt: "2026-04-29T00:00:00.000Z"
  });

  assert.equal(packet.recommendation, "ready_for_human_go");
  assert.equal(checkStatus(packet, "benchmark_run_evidence"), "pass");
  assert.deepEqual(packet.launch_blocked_until, [
    "H-006 human go/no-go decision",
    "QRM-030 launch activation"
  ]);

  await rm(root, { recursive: true, force: true });
});

test("fails benchmark readiness for placeholder run evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-042-placeholder-"));
  const workspacePath = path.join(root, "paul-graham");
  const artifactDir = path.join(root, "artifacts", "paul-graham");

  await writeReadyWorkspace(workspacePath);
  await writeBenchmarkRun(artifactDir, {
    answerPatch: { answer_text: "", model_response_id: "" }
  });

  const packet = await generatePaulGrahamLaunchReviewPacket({
    workspacePath,
    artifactDir,
    officialIndexHtml: '<html><body><a href="greatwork.html">How to Do Great Work</a></body></html>',
    generatedAt: "2026-04-29T00:00:00.000Z"
  });
  const benchmarkCheck = packet.checks.find((check) => check.key === "benchmark_run_evidence");

  assert.equal(packet.recommendation, "no_go");
  assert.equal(benchmarkCheck?.status, "fail");
  assert.ok(
    benchmarkCheck?.blockers.some((blocker) =>
      blocker.includes("model-backed response evidence")
    )
  );

  await rm(root, { recursive: true, force: true });
});

test("fails benchmark readiness when duplicated answers miss a scenario locale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-029-duplicate-benchmark-"));
  const workspacePath = path.join(root, "paul-graham");
  const artifactDir = path.join(root, "artifacts", "paul-graham");

  await writeReadyWorkspace(workspacePath);
  await writeBenchmarkRun(artifactDir, {
    answerPatch: { locale: "en" }
  });

  const packet = await generatePaulGrahamLaunchReviewPacket({
    workspacePath,
    artifactDir,
    officialIndexHtml: '<html><body><a href="greatwork.html">How to Do Great Work</a></body></html>',
    generatedAt: "2026-04-29T00:00:00.000Z"
  });
  const benchmarkCheck = packet.checks.find((check) => check.key === "benchmark_run_evidence");

  assert.equal(packet.recommendation, "no_go");
  assert.equal(benchmarkCheck?.status, "fail");
  assert.ok(
    benchmarkCheck?.blockers.includes("benchmark run is missing answer for choosing-great-work:ru")
  );

  await rm(root, { recursive: true, force: true });
});

test("fails benchmark readiness for wrong dataset, short answers, or not-passed result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-042-bad-benchmark-"));
  const workspacePath = path.join(root, "paul-graham");
  const artifactDir = path.join(root, "artifacts", "paul-graham");

  await writeReadyWorkspace(workspacePath);
  await writeBenchmarkRun(artifactDir, {
    datasetKey: "wrong-dataset",
    answerCount: 1,
    passed: false
  });

  const packet = await generatePaulGrahamLaunchReviewPacket({
    workspacePath,
    artifactDir,
    officialIndexHtml: '<html><body><a href="greatwork.html">How to Do Great Work</a></body></html>',
    generatedAt: "2026-04-29T00:00:00.000Z"
  });
  const benchmarkCheck = packet.checks.find((check) => check.key === "benchmark_run_evidence");

  assert.equal(packet.recommendation, "no_go");
  assert.equal(benchmarkCheck?.status, "fail");
  assert.ok(
    benchmarkCheck?.blockers.some((blocker) =>
      blocker.includes("dataset_key does not match")
    )
  );
  assert.ok(benchmarkCheck?.blockers.some((blocker) => blocker.includes("1/2 expected answers")));
  assert.ok(benchmarkCheck?.blockers.some((blocker) => blocker.includes("not marked passed")));

  await rm(root, { recursive: true, force: true });
});

test("fails corpus readiness when fragments are not approved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-029-corpus-"));
  const workspacePath = path.join(root, "paul-graham");
  const artifactDir = path.join(root, "artifacts", "paul-graham");

  await writeReadyWorkspace(workspacePath, { fragmentState: "draft" });

  const packet = await generatePaulGrahamLaunchReviewPacket({
    workspacePath,
    artifactDir,
    officialIndexHtml: '<html><body><a href="greatwork.html">How to Do Great Work</a></body></html>',
    generatedAt: "2026-04-29T00:00:00.000Z"
  });
  const corpusCheck = packet.checks.find((check) => check.key === "corpus_profile_readiness");

  assert.equal(corpusCheck?.status, "fail");
  assert.ok(
    corpusCheck?.blockers.some((blocker) => blocker.includes("approved fragment eligibility is incomplete"))
  );

  await rm(root, { recursive: true, force: true });
});

test("fails corpus readiness when documents are not approved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-042-document-state-"));
  const workspacePath = path.join(root, "paul-graham");
  const artifactDir = path.join(root, "artifacts", "paul-graham");

  await writeReadyWorkspace(workspacePath, { documentState: "embedded" });

  const packet = await generatePaulGrahamLaunchReviewPacket({
    workspacePath,
    artifactDir,
    officialIndexHtml: '<html><body><a href="greatwork.html">How to Do Great Work</a></body></html>',
    generatedAt: "2026-04-29T00:00:00.000Z"
  });
  const corpusCheck = packet.checks.find((check) => check.key === "corpus_profile_readiness");

  assert.equal(corpusCheck?.status, "fail");
  assert.equal(corpusCheck?.evidence.approved_document_count, 0);
  assert.ok(
    corpusCheck?.blockers.some((blocker) => blocker.includes("approved document eligibility is incomplete"))
  );

  await rm(root, { recursive: true, force: true });
});

test("fails topic-tag readiness when approved tags lack embeddings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-029-tags-"));
  const workspacePath = path.join(root, "paul-graham");
  const artifactDir = path.join(root, "artifacts", "paul-graham");

  await writeReadyWorkspace(workspacePath, { tagEmbedding: [] });

  const packet = await generatePaulGrahamLaunchReviewPacket({
    workspacePath,
    artifactDir,
    officialIndexHtml: '<html><body><a href="greatwork.html">How to Do Great Work</a></body></html>',
    generatedAt: "2026-04-29T00:00:00.000Z"
  });
  const tagCheck = packet.checks.find((check) => check.key === "topic_tag_readiness");

  assert.equal(tagCheck?.status, "fail");
  assert.ok(
    tagCheck?.blockers.some((blocker) => blocker.includes("approved topic-tag embeddings are incomplete"))
  );

  await rm(root, { recursive: true, force: true });
});

function checkStatus(
  packet: Awaited<ReturnType<typeof generatePaulGrahamLaunchReviewPacket>>,
  key: string
): string | undefined {
  return packet.checks.find((check) => check.key === key)?.status;
}

async function writeReadyWorkspace(
  workspacePath: string,
  options: { documentState?: string; fragmentState?: string; tagEmbedding?: number[] } = {}
): Promise<void> {
  const sourceKey = "pg-greatwork";
  const sourceId = workspaceSourceId("paul-graham", sourceKey);
  const fragmentId = workspaceFragmentId("paul-graham", sourceKey, 0);
  const tagEmbedding = options.tagEmbedding ?? EMBEDDING;

  await mkdir(path.join(workspacePath, "corpus", "text"), { recursive: true });
  await writeJson(path.join(workspacePath, "advisor.json"), {
    slug: "paul-graham",
    display_name: "Paul Graham",
    telegram_command: "paul_graham",
    short_bio: "Advisor built from Paul Graham public essays.",
    era_label: "Contemporary",
    domain_label: "Startups and essays",
    supported_locales: ["en", "ru"],
    disclaimer_text:
      "This AI advisor is inspired by the documented ideas and philosophy of Paul Graham. It is NOT Paul Graham, nor an official representation of Paul Graham. All responses are AI-generated based on publicly available sources."
  });
  await writeJson(path.join(workspacePath, "source-catalog.json"), {
    sources: [
      {
        source_key: sourceKey,
        title: "How to Do Great Work",
        creator: "Paul Graham",
        source_type: "essay",
        origin_class: "primary",
        language_code: "en",
        access_model: "free",
        acquisition_status: "approved",
        priority: "high",
        provenance_url: "https://www.paulgraham.com/greatwork.html"
      }
    ]
  });
  await writeJson(path.join(workspacePath, "topic-tags.json"), {
    schema_version: 1,
    advisor_slug: "paul-graham",
    visibility: "internal_only",
    tags: [
      {
        tag_key: "great_work",
        label: "Great Work",
        description: "Choosing ambitious work and compounding curiosity.",
        tag_state: "approved",
        embedding: tagEmbedding,
        embedding_model: "text-embedding-3-small",
        approved_at: "2026-04-29T00:00:00.000Z",
        input_checksum_sha256: "a".repeat(64),
        source_refs: [{ source_key: sourceKey, document_kind: "source_text", fragment_index: 0 }]
      }
    ]
  });
  await writeJson(path.join(workspacePath, "dossier-v1.json"), {
    version: 1,
    schema_version: 1,
    themes: [{ label: "Great work", fragment_ids: [fragmentId] }],
    core_ideas: [{ label: "Curiosity compounds", fragment_ids: [fragmentId] }],
    tone: { voice: "direct", cadence: "plain", do: ["be concrete"], avoid: ["hype"] },
    argument_patterns: [{ label: "Start concrete", fragment_ids: [fragmentId] }],
    quote_set: [{ label: "safe paraphrase", quote_text: "Do not overquote.", fragment_id: fragmentId }],
    red_lines: ["Do not claim to be Paul Graham."],
    secondary_context_notes: [{ source_id: sourceId, note: "Use as primary context." }],
    source_map: { primary_source_ids: [sourceId], secondary_source_ids: [] }
  });
  await writeJson(path.join(workspacePath, "benchmark-scenarios-v1.json"), {
    version: 1,
    dataset_key: "benchmark-paul-graham-v1",
    advisor_slug: "paul-graham",
    thresholds: { required_locales: ["en", "ru"] },
    scenarios: [
      {
        id: "choosing-great-work",
        retrieval_query_en: "great work curiosity",
        prompts: {
          en: "How should I choose what to work on?",
          ru: "Как выбрать, над чем работать?"
        },
        objectives: ["Use curiosity and concrete work."],
        coverage: { topic_tag_keys: ["great_work"], source_keys: [sourceKey] }
      }
    ]
  });
  await writeJson(path.join(workspacePath, "selection-profile-v1.json"), {
    version: 1,
    advisor_slug: "paul-graham",
    profile_text_en: "Paul Graham is a specialist fit for choosing great work.",
    embedding: EMBEDDING,
    embedding_model: "text-embedding-3-small",
    derived_from: {
      dossier_version: 1,
      topic_tag_keys: ["great_work"]
    },
    input_checksum_sha256: "b".repeat(64)
  });
  await writeJson(path.join(workspacePath, "corpus", "manifest.json"), {
    schema_version: 1,
    advisor_slug: "paul-graham",
    source_count: 1,
    document_count: 1,
    fragment_count: 1,
    embedding_model: "text-embedding-3-small",
    embedding_dimensions: 1536,
    documents: [
      {
        source_key: sourceKey,
        title: "How to Do Great Work",
        text_path: "corpus/text/pg-greatwork.txt",
        document_state: options.documentState ?? "approved",
        fragment_count: 1,
        fragments: [
          {
            fragment_index: 0,
            original_text_sha256: "c".repeat(64),
            retrieval_text_en_sha256: "c".repeat(64),
            embedding_dimensions: 1536,
            embedding_model: "text-embedding-3-small",
            fragment_state: options.fragmentState ?? "approved"
          }
        ]
      }
    ]
  });
  await writeFile(path.join(workspacePath, "corpus", "text", "pg-greatwork.txt"), "Great work starts concrete.\n");
}

async function writeBenchmarkRun(
  artifactDir: string,
  options: {
    datasetKey?: string;
    answerCount?: number;
    passed?: boolean;
    answerPatch?: Record<string, unknown>;
  } = {}
): Promise<void> {
  const answers = Array.from({ length: options.answerCount ?? 2 }, (_, index) => ({
    scenario_id: "choosing-great-work",
    locale: index === 0 ? "en" : "ru",
    prompt: index === 0 ? "How should I choose what to work on?" : "Как выбрать, над чем работать?",
    answer_text: "Paul Graham: Start with what you are genuinely curious about.",
    model_name: "gpt-5-mini",
    model_response_id: `resp_${index}`,
    generated_at: "2026-04-29T00:00:00.000Z",
    ...options.answerPatch
  }));

  await mkdir(artifactDir, { recursive: true });
  await writeJson(path.join(artifactDir, "benchmark-runs-v1.json"), {
    schema_version: 1,
    dataset_key: options.datasetKey ?? "benchmark-paul-graham-v1",
    advisor_slug: "paul-graham",
    generated_at: "2026-04-29T00:00:00.000Z",
    model_name: "gpt-5-mini",
    passed: options.passed ?? true,
    answers
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
