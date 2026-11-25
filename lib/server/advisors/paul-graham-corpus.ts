import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const PAUL_GRAHAM_CORPUS_WORKSPACE = path.join(
  process.cwd(),
  "advisors",
  "paul-graham"
);
export const PAUL_GRAHAM_CORPUS_DIR = path.join(PAUL_GRAHAM_CORPUS_WORKSPACE, "corpus");
export const PAUL_GRAHAM_CORPUS_MANIFEST = path.join(PAUL_GRAHAM_CORPUS_DIR, "manifest.json");
export const PAUL_GRAHAM_EMBEDDING_DIMENSIONS = 1536;

const DEFAULT_TARGET_CHARS = 1800;
const DEFAULT_OVERLAP_PARAGRAPHS = 1;

type JsonObject = Record<string, unknown>;

export type PaulGrahamCatalogSource = {
  sourceKey: string;
  title: string;
  languageCode: string;
  acquisitionStatus: string;
  provenanceUrl: string;
};

export type PaulGrahamCorpusFragment = {
  fragmentIndex: number;
  fragmentKind: "body";
  originalText: string;
  retrievalTextEn: string;
  originalLanguageCode: string;
  provenanceLocator: {
    kind: "essay_section";
    label: string;
    paragraph_start: number;
    paragraph_end: number;
  };
  embedding: number[];
  embeddingModel: string;
  fragmentState: "draft" | "approved";
};

export type PaulGrahamCorpusDocument = {
  sourceKey: string;
  documentKind: "source_text";
  title: string;
  originalLanguageCode: string;
  retrievalLanguageCode: "en";
  normalizedText: string;
  retrievalTextEn: string;
  sourceChecksumSha256: string;
  documentState: "embedded" | "approved";
  fragments: PaulGrahamCorpusFragment[];
};

export type PaulGrahamCorpusManifest = {
  schema_version: 1;
  advisor_slug: "paul-graham";
  source_count: number;
  document_count: number;
  fragment_count: number;
  embedding_model: string;
  embedding_dimensions: 1536;
  generated_at: string;
  documents: Array<{
    source_key: string;
    title: string;
    text_path: string;
    source_checksum_sha256: string;
    retrieval_language_code: "en";
    document_state: "embedded" | "approved";
    fragment_count: number;
    fragments: Array<{
      fragment_index: number;
      original_text_sha256: string;
      retrieval_text_en_sha256: string;
      provenance_locator: PaulGrahamCorpusFragment["provenanceLocator"];
      embedding_dimensions: 1536;
      embedding_model: string;
      fragment_state: "draft" | "approved";
    }>;
  }>;
};

export type PaulGrahamCorpusVerification = {
  sourceCount: number;
  documentCount: number;
  fragmentCount: number;
  embeddingDimensions: number | null;
  errors: string[];
};

export async function loadPaulGrahamCatalogSources(
  workspacePath = PAUL_GRAHAM_CORPUS_WORKSPACE
): Promise<PaulGrahamCatalogSource[]> {
  const catalog = await readJson(path.join(workspacePath, "source-catalog.json"));
  const sources = Array.isArray(catalog.sources) ? catalog.sources : [];

  return sources.flatMap((source) => {
    if (!isObject(source)) {
      return [];
    }

    const sourceKey = optionalString(source.source_key);
    const title = optionalString(source.title);
    const languageCode = optionalString(source.language_code);
    const acquisitionStatus = optionalString(source.acquisition_status);
    const provenanceUrl = optionalString(source.provenance_url);

    if (!sourceKey || !title || !languageCode || !acquisitionStatus || !provenanceUrl) {
      return [];
    }

    return [
      {
        sourceKey,
        title,
        languageCode,
        acquisitionStatus,
        provenanceUrl
      }
    ];
  });
}

export function normalizePaulGrahamEssayHtml(html: string): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|td|tr|h1|h2|h3)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtml(body)
    .normalize("NFKC")
    .replace(/\u00ad/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function chunkPaulGrahamEssayText(
  text: string,
  options: { targetChars?: number; overlapParagraphs?: number } = {}
): Array<{ text: string; paragraphStart: number; paragraphEnd: number }> {
  return chunkEssayText(text, {
    targetChars: options.targetChars ?? DEFAULT_TARGET_CHARS,
    overlapParagraphs: options.overlapParagraphs ?? DEFAULT_OVERLAP_PARAGRAPHS
  });
}

export function buildPaulGrahamCorpusDocument(
  source: PaulGrahamCatalogSource,
  normalizedText: string,
  embeddings: number[][],
  options: {
    embeddingModel: string;
    approve?: boolean;
    targetChars?: number;
    overlapParagraphs?: number;
  }
): PaulGrahamCorpusDocument {
  const chunks = chunkPaulGrahamEssayText(normalizedText, options);

  if (chunks.length !== embeddings.length) {
    throw new Error(
      `Expected ${chunks.length} embeddings for ${source.sourceKey}, received ${embeddings.length}.`
    );
  }

  const documentState = options.approve ? "approved" : "embedded";
  const fragmentState = options.approve ? "approved" : "draft";

  return {
    sourceKey: source.sourceKey,
    documentKind: "source_text",
    title: source.title,
    originalLanguageCode: source.languageCode,
    retrievalLanguageCode: "en",
    normalizedText,
    retrievalTextEn: normalizedText,
    sourceChecksumSha256: sha256(normalizedText),
    documentState,
    fragments: chunks.map((chunk, index) => {
      const embedding = embeddings[index] ?? [];

      if (embedding.length !== PAUL_GRAHAM_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Expected ${PAUL_GRAHAM_EMBEDDING_DIMENSIONS}-dimension embedding for ${source.sourceKey} fragment ${index}.`
        );
      }

      return {
        fragmentIndex: index,
        fragmentKind: "body",
        originalText: chunk.text,
        retrievalTextEn: chunk.text,
        originalLanguageCode: source.languageCode,
        provenanceLocator: {
          kind: "essay_section",
          label: `${source.title}, paragraphs ${chunk.paragraphStart}-${chunk.paragraphEnd}`,
          paragraph_start: chunk.paragraphStart,
          paragraph_end: chunk.paragraphEnd
        },
        embedding,
        embeddingModel: options.embeddingModel,
        fragmentState
      };
    })
  };
}

export function buildPaulGrahamCorpusManifest(
  documents: PaulGrahamCorpusDocument[],
  options: { embeddingModel: string; generatedAt: string }
): PaulGrahamCorpusManifest {
  const fragmentCount = documents.reduce((sum, document) => sum + document.fragments.length, 0);

  return {
    schema_version: 1,
    advisor_slug: "paul-graham",
    source_count: documents.length,
    document_count: documents.length,
    fragment_count: fragmentCount,
    embedding_model: options.embeddingModel,
    embedding_dimensions: PAUL_GRAHAM_EMBEDDING_DIMENSIONS,
    generated_at: options.generatedAt,
    documents: documents.map((document) => ({
      source_key: document.sourceKey,
      title: document.title,
      text_path: `corpus/text/${document.sourceKey}.txt`,
      source_checksum_sha256: document.sourceChecksumSha256,
      retrieval_language_code: document.retrievalLanguageCode,
      document_state: document.documentState,
      fragment_count: document.fragments.length,
      fragments: document.fragments.map((fragment) => ({
        fragment_index: fragment.fragmentIndex,
        original_text_sha256: sha256(fragment.originalText),
        retrieval_text_en_sha256: sha256(fragment.retrievalTextEn),
        provenance_locator: fragment.provenanceLocator,
        embedding_dimensions: PAUL_GRAHAM_EMBEDDING_DIMENSIONS,
        embedding_model: fragment.embeddingModel,
        fragment_state: fragment.fragmentState
      }))
    }))
  };
}

export function verifyPaulGrahamCorpusManifest(
  catalogSources: PaulGrahamCatalogSource[],
  manifest: PaulGrahamCorpusManifest
): PaulGrahamCorpusVerification {
  const errors: string[] = [];
  const catalogKeys = new Set(catalogSources.map((source) => source.sourceKey));
  const documentKeys = new Set<string>();
  let fragmentCount = 0;

  if (manifest.advisor_slug !== "paul-graham") {
    errors.push("manifest advisor_slug must be paul-graham");
  }

  if (manifest.embedding_dimensions !== PAUL_GRAHAM_EMBEDDING_DIMENSIONS) {
    errors.push(`manifest embedding_dimensions must be ${PAUL_GRAHAM_EMBEDDING_DIMENSIONS}`);
  }

  for (const document of manifest.documents) {
    if (!catalogKeys.has(document.source_key)) {
      errors.push(`manifest document source_key is not in source catalog: ${document.source_key}`);
    }

    if (documentKeys.has(document.source_key)) {
      errors.push(`manifest document source_key is duplicated: ${document.source_key}`);
    }

    documentKeys.add(document.source_key);

    if (document.retrieval_language_code !== "en") {
      errors.push(`manifest document ${document.source_key} retrieval_language_code must be en`);
    }

    if (!/^[0-9a-f]{64}$/.test(document.source_checksum_sha256)) {
      errors.push(`manifest document ${document.source_key} source checksum is invalid`);
    }

    if (document.fragment_count !== document.fragments.length) {
      errors.push(`manifest document ${document.source_key} fragment_count is inconsistent`);
    }

    if (document.fragment_count === 0) {
      errors.push(`manifest document ${document.source_key} must contain at least one fragment`);
    }

    const fragmentIndexes = new Set<number>();

    for (const fragment of document.fragments) {
      fragmentCount += 1;

      if (fragmentIndexes.has(fragment.fragment_index)) {
        errors.push(
          `manifest document ${document.source_key} has duplicated fragment index ${fragment.fragment_index}`
        );
      }

      fragmentIndexes.add(fragment.fragment_index);

      if (fragment.embedding_dimensions !== PAUL_GRAHAM_EMBEDDING_DIMENSIONS) {
        errors.push(
          `manifest document ${document.source_key} fragment ${fragment.fragment_index} embedding dimension is invalid`
        );
      }

      if (fragment.provenance_locator.kind !== "essay_section") {
        errors.push(
          `manifest document ${document.source_key} fragment ${fragment.fragment_index} locator kind must be essay_section`
        );
      }
    }
  }

  for (const source of catalogSources) {
    if (!documentKeys.has(source.sourceKey) && !["blocked", "rejected"].includes(source.acquisitionStatus)) {
      errors.push(`source catalog entry has no corpus document or blocked/rejected state: ${source.sourceKey}`);
    }
  }

  if (manifest.document_count !== manifest.documents.length) {
    errors.push("manifest document_count is inconsistent");
  }

  if (manifest.fragment_count !== fragmentCount) {
    errors.push("manifest fragment_count is inconsistent");
  }

  return {
    sourceCount: catalogSources.length,
    documentCount: manifest.documents.length,
    fragmentCount,
    embeddingDimensions: manifest.embedding_dimensions,
    errors
  };
}

function chunkEssayText(
  text: string,
  options: { targetChars: number; overlapParagraphs: number }
): Array<{ text: string; paragraphStart: number; paragraphEnd: number }> {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const chunks: Array<{ text: string; paragraphStart: number; paragraphEnd: number }> = [];
  let index = 0;

  while (index < paragraphs.length) {
    const start = index;
    const parts: string[] = [];
    let length = 0;

    while (index < paragraphs.length && (parts.length === 0 || length < options.targetChars)) {
      const paragraph = paragraphs[index] ?? "";

      parts.push(paragraph);
      length += paragraph.length + 2;
      index += 1;
    }

    chunks.push({
      text: parts.join("\n\n"),
      paragraphStart: start + 1,
      paragraphEnd: index
    });

    if (index < paragraphs.length && options.overlapParagraphs > 0) {
      index = Math.max(index - options.overlapParagraphs, start + 1);
    }
  }

  return chunks;
}

async function readJson(filePath: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(value)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return value;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
