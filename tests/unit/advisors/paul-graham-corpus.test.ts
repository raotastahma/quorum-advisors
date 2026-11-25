import assert from "node:assert/strict";
import test from "node:test";
import {
  PAUL_GRAHAM_EMBEDDING_DIMENSIONS,
  buildPaulGrahamCorpusDocument,
  buildPaulGrahamCorpusManifest,
  chunkPaulGrahamEssayText,
  normalizePaulGrahamEssayHtml,
  verifyPaulGrahamCorpusManifest,
  type PaulGrahamCatalogSource
} from "../../../lib/server/advisors/paul-graham-corpus.ts";

const SOURCE: PaulGrahamCatalogSource = {
  sourceKey: "pg-greatwork",
  title: "How to Do Great Work",
  languageCode: "en",
  acquisitionStatus: "approved",
  provenanceUrl: "https://www.paulgraham.com/greatwork.html"
};

test("normalizes Paul Graham essay HTML into retrieval text", () => {
  const text = normalizePaulGrahamEssayHtml(`
    <html><head><style>.x{}</style></head>
    <body><table><tr><td>July 2023<br><br>If you collected ideas &amp; examples.</td></tr></table></body></html>
  `);

  assert.equal(text, "July 2023\n\nIf you collected ideas & examples.");
});

test("chunks essays with paragraph locators and overlap", () => {
  const chunks = chunkPaulGrahamEssayText("One.\n\nTwo is longer.\n\nThree.\n\nFour.", {
    targetChars: 17,
    overlapParagraphs: 1
  });

  assert.deepEqual(
    chunks.map((chunk) => [chunk.paragraphStart, chunk.paragraphEnd]),
    [
      [1, 2],
      [2, 3],
      [3, 4]
    ]
  );
});

test("builds corpus documents with checksums, locators, and embedding dimensions", () => {
  const normalizedText = "First paragraph.\n\nSecond paragraph.";
  const embedding = Array.from({ length: PAUL_GRAHAM_EMBEDDING_DIMENSIONS }, () => 0.01);
  const document = buildPaulGrahamCorpusDocument(SOURCE, normalizedText, [embedding], {
    embeddingModel: "text-embedding-3-small",
    targetChars: 1000
  });

  assert.equal(document.retrievalLanguageCode, "en");
  assert.equal(document.documentState, "embedded");
  assert.match(document.sourceChecksumSha256, /^[0-9a-f]{64}$/);
  assert.equal(document.fragments.length, 1);
  assert.equal(document.fragments[0]?.fragmentState, "draft");
  assert.equal(document.fragments[0]?.embedding.length, PAUL_GRAHAM_EMBEDDING_DIMENSIONS);
  assert.equal(document.fragments[0]?.provenanceLocator.kind, "essay_section");
});

test("verifies source coverage and rejects bad manifest dimensions", () => {
  const embedding = Array.from({ length: PAUL_GRAHAM_EMBEDDING_DIMENSIONS }, () => 0.01);
  const document = buildPaulGrahamCorpusDocument(SOURCE, "Only paragraph.", [embedding], {
    embeddingModel: "text-embedding-3-small"
  });
  const manifest = buildPaulGrahamCorpusManifest([document], {
    embeddingModel: "text-embedding-3-small",
    generatedAt: "2026-04-28T00:00:00.000Z"
  });

  assert.deepEqual(verifyPaulGrahamCorpusManifest([SOURCE], manifest).errors, []);

  const badManifest = {
    ...manifest,
    embedding_dimensions: 10 as 1536,
    documents: []
  };
  const badReport = verifyPaulGrahamCorpusManifest([SOURCE], badManifest);

  assert.ok(
    badReport.errors.some((error) =>
      error.includes("source catalog entry has no corpus document or blocked/rejected state")
    )
  );
  assert.ok(
    badReport.errors.some((error) => error.includes("manifest embedding_dimensions must be 1536"))
  );
});
