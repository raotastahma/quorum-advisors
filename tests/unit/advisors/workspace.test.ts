import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAdvisorWorkspacePublishPlan,
  publishAdvisorWorkspace,
  validateAdvisorWorkspace
} from "../../../lib/server/advisors/workspace.ts";
import { workspaceFragmentId, workspaceSourceId } from "../../../lib/server/advisors/workspace-ids.ts";

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const EMBEDDING_DIMENSIONS = 1536;

test("validates the minimum advisor workspace and computes lowercase checksums", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-025-workspace-"));
  const workspacePath = await writeWorkspace(root, "hypatia", {
    command: "hypatia"
  });

  const result = await validateAdvisorWorkspace(workspacePath);

  assert.deepEqual(result.errors, []);
  assert.match(result.checksums.aggregateChecksumSha256, HEX_SHA256);
  assert.match(result.checksums.inputFiles["advisor.json"] ?? "", HEX_SHA256);
  assert.match(result.checksums.inputFiles["source-catalog.json"] ?? "", HEX_SHA256);
  assert.match(result.checksums.inputFiles["dossier-v1.json"] ?? "", HEX_SHA256);
  assert.match(result.checksums.corpusFiles["corpus/source.txt"] ?? "", HEX_SHA256);

  const plan = await buildAdvisorWorkspacePublishPlan(workspacePath);

  assert.equal(plan.advisor.slug, "hypatia");
  assert.equal(plan.advisor.telegram_command, "hypatia");
  assert.match(String(plan.sources[0]?.input_checksum_sha256), HEX_SHA256);
  assert.match(String(plan.topicTags[0]?.input_checksum_sha256), HEX_SHA256);
  assert.match(String(plan.dossier.input_checksum_sha256), HEX_SHA256);
  assert.match(String(plan.benchmarkScenarios.input_checksum_sha256), HEX_SHA256);

  await rm(root, { recursive: true, force: true });
});

test("rejects a missing required workspace file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-025-missing-"));
  const workspacePath = await writeWorkspace(root, "missing-tag-file", {
    command: "missing_tag_file"
  });

  await unlink(path.join(workspacePath, "topic-tags.json"));

  const result = await validateAdvisorWorkspace(workspacePath);

  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "topic-tags.json" &&
        error.message === "required workspace file is missing"
    )
  );

  await rm(root, { recursive: true, force: true });
});

test("rejects empty, malformed, reserved, and duplicate telegram_command values", async () => {
  const invalidRoot = await mkdtemp(path.join(tmpdir(), "qrm-025-invalid-command-"));

  for (const [slug, command] of [
    ["empty-command", ""],
    ["uppercase-command", "BadCommand"],
    ["reserved-command", "all"]
  ] as const) {
    const workspacePath = await writeWorkspace(invalidRoot, slug, {
      command
    });
    const result = await validateAdvisorWorkspace(workspacePath);

    assert.ok(
      result.errors.some((error) => error.path === "advisor.json.telegram_command"),
      `${command} should be rejected`
    );
  }

  const duplicateRoot = await mkdtemp(path.join(tmpdir(), "qrm-025-duplicate-command-"));
  const brokenSiblingPath = path.join(duplicateRoot, "000-broken-sibling");

  await mkdir(brokenSiblingPath);
  await writeFile(path.join(brokenSiblingPath, "advisor.json"), "{bad json");
  await writeWorkspace(duplicateRoot, "first-advisor", {
    command: "same_command"
  });
  const duplicateWorkspacePath = await writeWorkspace(duplicateRoot, "second-advisor", {
    command: "same_command"
  });
  const duplicateResult = await validateAdvisorWorkspace(duplicateWorkspacePath);

  assert.ok(
    duplicateResult.errors.some((error) =>
      error.message.includes("telegram_command duplicates first-advisor")
    )
  );

  await rm(invalidRoot, { recursive: true, force: true });
  await rm(duplicateRoot, { recursive: true, force: true });
});

test("rejects malformed supported_locales during validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-025-invalid-locales-"));
  const workspacePath = await writeWorkspace(root, "invalid-locales", {
    command: "invalid_locales",
    supportedLocales: [123]
  });

  const result = await validateAdvisorWorkspace(workspacePath);

  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "advisor.json.supported_locales" &&
        error.message === "supported_locales must be a non-empty string array"
    )
  );

  await rm(root, { recursive: true, force: true });
});

test("rejects non-object source and topic tag catalog entries during validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-025-invalid-catalog-"));
  const workspacePath = await writeWorkspace(root, "invalid-catalog", {
    command: "invalid_catalog"
  });

  await writeJson(path.join(workspacePath, "source-catalog.json"), {
    sources: [
      {
        source_key: "primary-source",
        title: "Primary Source",
        source_type: "book",
        origin_class: "primary",
        language_code: "en",
        access_model: "free"
      },
      123
    ]
  });
  await writeJson(path.join(workspacePath, "topic-tags.json"), {
    tags: [
      {
        tag_key: "philosophy",
        label: "Philosophy"
      },
      123
    ]
  });

  const result = await validateAdvisorWorkspace(workspacePath);

  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "source-catalog.json.sources[1]" &&
        error.message === "catalog row must be an object"
    )
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "topic-tags.json.tags[1]" &&
        error.message === "catalog row must be an object"
    )
  );

  await rm(root, { recursive: true, force: true });
});

test("publishes runtime rows from workspace data without launch-enabling an advisor", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-025-publish-"));
  const workspacePath = await writeWorkspace(root, "ada-lovelace", {
    command: "ada_lovelace",
    displayName: "Ada Lovelace"
  });
  const sourceId = workspaceSourceId("ada-lovelace", "primary-source");
  const originalFetch = globalThis.fetch;
  const captured: { path: string; body: string | null }[] = [];

  await writeJson(path.join(workspacePath, "dossier-v1.json"), {
    version: 1,
    schema_version: 1,
    themes: [],
    core_ideas: [],
    tone: {
      voice: "clear",
      cadence: "measured",
      do: [],
      avoid: []
    },
    argument_patterns: [],
    quote_set: [],
    red_lines: [],
    secondary_context_notes: [
      {
        source_id: sourceId,
        note: "Use as primary context."
      }
    ],
    source_map: {
      primary_source_ids: [sourceId],
      secondary_source_ids: []
    }
  });

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    captured.push({
      path: url.pathname,
      body: typeof init?.body === "string" ? init.body : null
    });

    if (url.pathname.endsWith("/rpc/quorum_publish_advisor_metadata")) {
      return Response.json([{ id: "00000000-0000-4000-8000-000000000101" }]);
    }

    if (url.pathname.endsWith("/advisor_dossiers")) {
      return Response.json([{ id: "00000000-0000-4000-8000-000000000202" }]);
    }

    return new Response(null, { status: 204 });
  };

  const result = await publishAdvisorWorkspace(
    {
      telegramBotToken: "123456:telegram-bot-token",
      telegramWebhookSecret: "secret",
      supabaseUrl: "http://supabase.test",
      supabaseSecretKey: "service-role"
    },
    workspacePath
  );

  const advisorBody = parseBody(captured, "/rest/v1/rpc/quorum_publish_advisor_metadata");
  const sourceBody = parseBody(captured, "/rest/v1/advisor_sources");
  const tagBody = parseBody(captured, "/rest/v1/advisor_topic_tags");
  const dossierBody = parseBody(captured, "/rest/v1/advisor_dossiers");
  const moduleText = await readFile(
    path.join(process.cwd(), "lib/server/advisors/workspace.ts"),
    "utf8"
  );

  assert.equal(result.advisorId, "00000000-0000-4000-8000-000000000101");
  assert.equal(result.dossierId, "00000000-0000-4000-8000-000000000202");
  assert.equal(advisorBody.p_slug, "ada-lovelace");
  assert.equal(advisorBody.p_telegram_command, "ada_lovelace");
  assert.equal(advisorBody.p_display_name, "Ada Lovelace");
  assert.equal("is_launch_enabled" in advisorBody, false);
  assert.equal("readiness_status" in advisorBody, false);
  assert.equal("persona_status" in advisorBody, false);
  assert.equal(
    captured.some((request) => request.path === "/rest/v1/advisors"),
    false
  );
  assert.equal(sourceBody[0]?.id, sourceId);
  assert.equal(sourceBody[0]?.advisor_id, "00000000-0000-4000-8000-000000000101");
  assert.match(String(sourceBody[0]?.input_checksum_sha256), HEX_SHA256);
  assert.equal(tagBody[0]?.tag_state, "pending");
  assert.equal(dossierBody[0]?.is_current, false);
  assert.equal(dossierBody[0]?.artifact_state, "pending");
  assert.deepEqual(dossierBody[0]?.payload.source_map.primary_source_ids, [sourceId]);
  assert.equal(dossierBody[0]?.payload.secondary_context_notes[0]?.source_id, sourceId);
  assert.doesNotMatch(moduleText, /marcus|paul/i);

  await rm(root, { recursive: true, force: true });
});

test("validates embedded topic tags, selection profile, and dossier fragment references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-028-profile-"));
  const workspacePath = await writeWorkspace(root, "paul-graham", {
    command: "paul_graham",
    displayName: "Paul Graham"
  });
  const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.001);
  const sourceId = workspaceSourceId("paul-graham", "primary-source");
  const fragmentId = workspaceFragmentId("paul-graham", "primary-source", 0);

  await writeJson(path.join(workspacePath, "corpus/manifest.json"), {
    advisor_slug: "paul-graham",
    documents: [
      {
        source_key: "primary-source",
        fragments: [
          {
            fragment_index: 0
          }
        ]
      }
    ]
  });
  await writeJson(path.join(workspacePath, "topic-tags.json"), {
    tags: [
      {
        tag_key: "startup_ideas",
        label: "Startup Ideas",
        description: "Finding startup ideas from user needs.",
        input_checksum_sha256: "a".repeat(64),
        embedding,
        embedding_model: "text-embedding-3-small"
      }
    ]
  });
  await writeJson(path.join(workspacePath, "dossier-v1.json"), {
    version: 1,
    schema_version: 1,
    themes: [
      {
        key: "ideas_from_users",
        label: "Ideas From Users",
        summary: "Good startup ideas are grounded in real user needs.",
        fragment_ids: [fragmentId]
      }
    ],
    core_ideas: [],
    tone: {
      voice: "plain",
      cadence: "direct",
      do: [],
      avoid: []
    },
    argument_patterns: [],
    quote_set: [
      {
        fragment_id: fragmentId,
        label: "users",
        quote_text: "Start with users."
      }
    ],
    red_lines: [],
    secondary_context_notes: [
      {
        source_id: sourceId,
        note: "Use as primary context."
      }
    ],
    source_map: {
      primary_source_ids: [sourceId],
      secondary_source_ids: []
    }
  });
  await writeJson(path.join(workspacePath, "benchmark-scenarios-v1.json"), {
    version: 1,
    dataset_key: "benchmark-paul-graham-v1",
    thresholds: {
      required_locales: ["en", "ru"]
    },
    scenarios: [
      {
        id: "startup-ideas",
        title: "Startup Ideas",
        retrieval_query_en: "Paul Graham on startup ideas and user needs.",
        objectives: ["Ground the answer in user needs."],
        coverage: {
          topic_tag_keys: ["startup_ideas"]
        },
        prompts: {
          en: "How should I find startup ideas?",
          ru: "Как искать идеи для стартапа?"
        }
      }
    ]
  });
  await writeJson(path.join(workspacePath, "selection-profile-v1.json"), {
    version: 1,
    advisor_slug: "paul-graham",
    profile_text_en: "Paul Graham advises on startup ideas from user needs.",
    embedding,
    embedding_model: "text-embedding-3-small",
    derived_from: {
      dossier_version: 1,
      topic_tag_keys: ["startup_ideas"],
      topic_tag_input_checksums: {
        startup_ideas: "a".repeat(64)
      }
    }
  });

  const result = await validateAdvisorWorkspace(workspacePath);
  const plan = await buildAdvisorWorkspacePublishPlan(workspacePath);

  assert.deepEqual(result.errors, []);
  assert.equal(plan.topicTags[0]?.tag_key, "startup_ideas");
  assert.equal((plan.topicTags[0]?.embedding as number[]).length, EMBEDDING_DIMENSIONS);
  assert.equal((plan.selectionProfile?.embedding as number[]).length, EMBEDDING_DIMENSIONS);
  assert.match(String(plan.selectionProfile?.input_checksum_sha256), HEX_SHA256);

  await rm(root, { recursive: true, force: true });
});

test("validates the original demo advisor workspace", async () => {
  const workspacePath = path.join(process.cwd(), "advisors", "demo-mentor");
  const result = await validateAdvisorWorkspace(workspacePath);
  const plan = await buildAdvisorWorkspacePublishPlan(workspacePath);
  assert.deepEqual(result.errors, []);
  assert.equal(plan.advisor.slug, "demo-mentor");
  assert.equal(plan.advisor.telegram_command, "demo_mentor");
  assert.equal(plan.sources.length, 1);
  assert.equal(plan.sources[0]?.source_key, "original-demo-notes");
  assert.equal("is_launch_enabled" in plan.advisor, false);
});

test("demo corpus contains original text and no deployment identifiers", async () => {
  const source = await readFile(path.join(process.cwd(), "advisors/demo-mentor/corpus/source.txt"), "utf8");
  const moduleText = await readFile(path.join(process.cwd(), "lib/server/advisors/workspace.ts"), "utf8");
  assert.match(source, /small reversible experiment/);
  assert.doesNotMatch(source, /https?:\/\/|@|\/Users\//);
  assert.doesNotMatch(moduleText, /marcus|paul/i);
});

test("rejects exposed topic tags, bad selection embeddings, and cross-advisor dossier references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-028-invalid-profile-"));
  const workspacePath = await writeWorkspace(root, "paul-graham", {
    command: "paul_graham",
    displayName: "Paul Graham"
  });

  await writeJson(path.join(workspacePath, "corpus/manifest.json"), {
    advisor_slug: "other-advisor",
    documents: []
  });
  await writeJson(path.join(workspacePath, "topic-tags.json"), {
    tags: [
      {
        tag_key: "startup_ideas",
        label: "Startup Ideas",
        description: "Finding startup ideas from user needs.",
        input_checksum_sha256: "a".repeat(64),
        user_visible: true
      }
    ]
  });
  await writeJson(path.join(workspacePath, "dossier-v1.json"), {
    version: 1,
    schema_version: 1,
    themes: [
      {
        key: "foreign",
        label: "Foreign",
        summary: "Invalid cross-advisor reference.",
        fragment_ids: ["00000000-0000-4000-8000-000000000999"]
      }
    ],
    core_ideas: [],
    tone: {
      voice: "plain",
      cadence: "direct",
      do: [],
      avoid: []
    },
    argument_patterns: [],
    quote_set: [],
    red_lines: [],
    secondary_context_notes: [
      {
        source_id: "00000000-0000-4000-8000-000000000998",
        note: "Invalid source."
      }
    ],
    source_map: {
      primary_source_ids: ["00000000-0000-4000-8000-000000000998"],
      secondary_source_ids: []
    }
  });
  await writeJson(path.join(workspacePath, "selection-profile-v1.json"), {
    version: 1,
    profile_text_en: "Bad profile.",
    embedding: [0.1],
    embedding_model: "text-embedding-3-small",
    derived_from: {
      dossier_version: 1,
      topic_tag_keys: ["startup_ideas"],
      topic_tag_input_checksums: {
        startup_ideas: "b".repeat(64)
      }
    }
  });

  const result = await validateAdvisorWorkspace(workspacePath);

  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "topic-tags.json.tags[0].user_visible" &&
        error.message === "topic tags are internal-only metadata"
    )
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "selection-profile-v1.json.embedding" &&
        error.message === "embedding must contain 1536 numbers"
    )
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "selection-profile-v1.json.derived_from.topic_tag_input_checksums.startup_ideas" &&
        error.message === "topic tag checksum must match topic-tags.json"
    )
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "corpus/manifest.json.advisor_slug" &&
        error.message === "corpus manifest advisor_slug must match workspace directory name"
    )
  );
  assert.ok(
    result.errors.some(
      (error) => error.message === "fragment_id 00000000-0000-4000-8000-000000000999 is not in corpus/manifest.json"
    )
  );
  assert.ok(
    result.errors.some(
      (error) => error.message === "source_id 00000000-0000-4000-8000-000000000998 is not in source-catalog.json"
    )
  );

  await rm(root, { recursive: true, force: true });
});

test("rejects broad approved topic tags without selection-grade source grounding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-028-broad-tags-"));
  const workspacePath = await writeWorkspace(root, "broad-advisor", {
    command: "broad_advisor"
  });
  const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.001);

  await writeJson(path.join(workspacePath, "topic-tags.json"), {
    tags: [
      {
        tag_key: "business",
        label: "Business",
        description: "General domain category.",
        tag_state: "approved",
        approved_at: "2026-04-29T00:00:00Z",
        input_checksum_sha256: "a".repeat(64),
        embedding,
        embedding_model: "text-embedding-3-small"
      }
    ]
  });

  const result = await validateAdvisorWorkspace(workspacePath);

  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "topic-tags.json.tags[0].tag_key" &&
        error.message === "approved topic tag is too broad for advisor selection routing"
    )
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "topic-tags.json.tags[0].description" &&
        error.message === "approved topic tag description must name the user problem shape"
    )
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "topic-tags.json.tags[0].source_refs" &&
        error.message === "approved topic tags must include source_refs"
    )
  );

  await rm(root, { recursive: true, force: true });
});

test("rejects dossier payloads that still use key and index references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-028-legacy-dossier-"));
  const workspacePath = await writeWorkspace(root, "paul-graham", {
    command: "paul_graham",
    displayName: "Paul Graham"
  });

  await writeJson(path.join(workspacePath, "corpus/manifest.json"), {
    advisor_slug: "paul-graham",
    documents: [
      {
        source_key: "primary-source",
        fragments: [
          {
            fragment_index: 0
          }
        ]
      }
    ]
  });
  await writeJson(path.join(workspacePath, "dossier-v1.json"), {
    version: 1,
    schema_version: 1,
    themes: [
      {
        key: "legacy",
        label: "Legacy",
        summary: "Old shape.",
        fragment_refs: [
          {
            source_key: "primary-source",
            document_kind: "source_text",
            fragment_index: 0
          }
        ]
      }
    ],
    core_ideas: [],
    tone: {
      voice: "plain",
      cadence: "direct",
      do: [],
      avoid: []
    },
    argument_patterns: [],
    quote_set: [
      {
        source_key: "primary-source",
        document_kind: "source_text",
        fragment_index: 0,
        label: "legacy",
        quote_text: "Legacy quote."
      }
    ],
    red_lines: [],
    secondary_context_notes: [
      {
        source_key: "primary-source",
        note: "Legacy source reference."
      }
    ],
    source_map: {
      primary_source_keys: ["primary-source"],
      secondary_source_keys: []
    }
  });

  const result = await validateAdvisorWorkspace(workspacePath);

  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "dossier-v1.json.themes[0].fragment_refs" &&
        error.message === "fragment_refs is not part of advisor_dossiers.payload schema v1; use fragment_ids"
    )
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "dossier-v1.json.quote_set[0].source_key" &&
        error.message === "source_key is not part of advisor_dossiers.payload schema v1; use fragment_id"
    )
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "dossier-v1.json.secondary_context_notes[0].source_key" &&
        error.message === "source_key is not part of advisor_dossiers.payload schema v1; use source_id"
    )
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "dossier-v1.json.source_map.primary_source_keys" &&
        error.message === "primary_source_keys is not part of advisor_dossiers.payload schema v1; use primary_source_ids"
    )
  );

  await rm(root, { recursive: true, force: true });
});

async function writeWorkspace(
  root: string,
  slug: string,
  options: {
    command: string;
    displayName?: string;
    supportedLocales?: unknown[];
  }
): Promise<string> {
  const workspacePath = path.join(root, slug);

  await mkdir(path.join(workspacePath, "corpus"), { recursive: true });
  await writeJson(path.join(workspacePath, "advisor.json"), {
    display_name: options.displayName ?? "Hypatia",
    telegram_command: options.command,
    short_bio: "Mathematician and philosopher.",
    era_label: "Late antiquity",
    domain_label: "Mathematics and philosophy",
    disclaimer_text:
      "This AI advisor is inspired by the documented ideas and philosophy of Test Advisor. It is NOT Test Advisor, nor an official representation of Test Advisor. All responses are AI-generated based on publicly available sources.",
    supported_locales: options.supportedLocales ?? ["en", "ru"]
  });
  await writeJson(path.join(workspacePath, "source-catalog.json"), {
    sources: [
      {
        source_key: "primary-source",
        title: "Primary Source",
        source_type: "book",
        origin_class: "primary",
        language_code: "en",
        access_model: "free",
        priority: "high",
        corpus_path: "corpus/source.txt"
      }
    ]
  });
  await writeJson(path.join(workspacePath, "topic-tags.json"), {
    tags: [
      {
        tag_key: "philosophy",
        label: "Philosophy",
        description: "Reasoning and inquiry"
      }
    ]
  });
  await writeJson(path.join(workspacePath, "dossier-v1.json"), {
    version: 1,
    schema_version: 1,
    themes: [],
    core_ideas: [],
    tone: {
      voice: "clear",
      cadence: "measured",
      do: [],
      avoid: []
    },
    argument_patterns: [],
    quote_set: [],
    red_lines: [],
    secondary_context_notes: [],
    source_map: {
      primary_source_ids: [],
      secondary_source_ids: []
    }
  });
  await writeJson(path.join(workspacePath, "benchmark-scenarios-v1.json"), {
    version: 1,
    dataset_key: `benchmark-${slug}-v1`,
    scenarios: [
      {
        id: "first-scenario",
        title: "First Scenario",
        retrieval_query_en: "How to think clearly.",
        objectives: ["Answer with clear reasoning."],
        prompts: {
          en: "How should I think about a hard problem?"
        }
      }
    ]
  });
  await writeFile(path.join(workspacePath, "corpus/source.txt"), "Source text.\n");

  return workspacePath;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseBody(captured: { path: string; body: string | null }[], pathName: string): any {
  const match = captured.find((request) => request.path === pathName);

  assert.ok(match?.body);

  return JSON.parse(match.body) as any;
}
