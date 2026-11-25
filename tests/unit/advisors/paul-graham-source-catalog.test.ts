import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parsePaulGrahamEssayIndex,
  verifyPaulGrahamSourceCatalog
} from "../../../lib/server/advisors/paul-graham-source-catalog.ts";

const INDEX_HTML = `
  <html>
    <body>
      <a href="greatwork.html">How to Do Great Work</a>
      <a href="kids.html">Having Kids</a>
      <a href="greatwork.html">How to Do Great Work</a>
      <a href="rss.html">RSS</a>
    </body>
  </html>
`;

test("parses official essay index links into stable source keys", () => {
  const links = parsePaulGrahamEssayIndex(INDEX_HTML);

  assert.deepEqual(links, [
    {
      title: "How to Do Great Work",
      url: "https://www.paulgraham.com/greatwork.html",
      sourceKey: "pg-greatwork"
    },
    {
      title: "Having Kids",
      url: "https://www.paulgraham.com/kids.html",
      sourceKey: "pg-kids"
    }
  ]);
});

test("validates catalog completeness and rejects duplicate or empty source keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-026-pg-catalog-"));
  const workspacePath = path.join(root, "paul-graham");

  await mkdir(workspacePath, { recursive: true });
  await writeJson(path.join(workspacePath, "advisor.json"), {
    display_name: "Paul Graham",
    telegram_command: "paul_graham",
    short_bio: "Advisor built from Paul Graham essay pages.",
    era_label: "Contemporary",
    domain_label: "Startups and essays",
    disclaimer_text:
      "This AI advisor is inspired by the documented ideas and philosophy of Paul Graham. It is NOT Paul Graham, nor an official representation of Paul Graham. All responses are AI-generated based on publicly available sources.",
    supported_locales: ["en", "ru"]
  });
  await writeJson(path.join(workspacePath, "source-catalog.json"), {
    sources: [
      source("pg-greatwork", "How to Do Great Work", "https://www.paulgraham.com/greatwork.html"),
      source("", "Having Kids", "https://www.paulgraham.com/kids.html"),
      source("pg-greatwork", "Having Kids", "https://www.paulgraham.com/kids.html")
    ]
  });

  const result = await verifyPaulGrahamSourceCatalog(workspacePath, INDEX_HTML);

  assert.ok(
    result.errors.some((error) =>
      error.includes("source-catalog.json.sources[1].source_key must be a non-empty string")
    )
  );
  assert.ok(
    result.errors.some((error) =>
      error.includes("source-catalog.json.sources[2].source_key is duplicated")
    )
  );

  await rm(root, { recursive: true, force: true });
});

test("rejects provenance URLs that differ from the official index link", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-026-pg-url-mismatch-"));
  const workspacePath = path.join(root, "paul-graham");

  await mkdir(workspacePath, { recursive: true });
  await writeJson(path.join(workspacePath, "advisor.json"), {
    display_name: "Paul Graham",
    telegram_command: "paul_graham",
    short_bio: "Advisor built from Paul Graham essay pages.",
    era_label: "Contemporary",
    domain_label: "Startups and essays",
    disclaimer_text:
      "This AI advisor is inspired by the documented ideas and philosophy of Paul Graham. It is NOT Paul Graham, nor an official representation of Paul Graham. All responses are AI-generated based on publicly available sources.",
    supported_locales: ["en", "ru"]
  });
  await writeJson(path.join(workspacePath, "source-catalog.json"), {
    sources: [
      source("pg-greatwork", "How to Do Great Work", "https://www.paulgraham.com/articles.html"),
      source("pg-kids", "Having Kids", "https://www.paulgraham.com/kids.html")
    ]
  });

  const result = await verifyPaulGrahamSourceCatalog(workspacePath, INDEX_HTML);

  assert.ok(
    result.errors.some((error) =>
      error.includes(
        "source-catalog.json.sources[0].provenance_url must match official essay URL https://www.paulgraham.com/greatwork.html"
      )
    )
  );

  await rm(root, { recursive: true, force: true });
});

test("validates exact official index title coverage without full essay text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qrm-026-pg-complete-"));
  const workspacePath = path.join(root, "paul-graham");

  await mkdir(workspacePath, { recursive: true });
  await writeJson(path.join(workspacePath, "advisor.json"), {
    display_name: "Paul Graham",
    telegram_command: "paul_graham",
    short_bio: "Advisor built from Paul Graham essay pages.",
    era_label: "Contemporary",
    domain_label: "Startups and essays",
    disclaimer_text:
      "This AI advisor is inspired by the documented ideas and philosophy of Paul Graham. It is NOT Paul Graham, nor an official representation of Paul Graham. All responses are AI-generated based on publicly available sources.",
    supported_locales: ["en", "ru"]
  });
  await writeJson(path.join(workspacePath, "source-catalog.json"), {
    sources: [
      source("pg-greatwork", "How to Do Great Work", "https://www.paulgraham.com/greatwork.html"),
      source("pg-kids", "Having Kids", "https://www.paulgraham.com/kids.html")
    ]
  });

  const result = await verifyPaulGrahamSourceCatalog(workspacePath, INDEX_HTML);

  assert.deepEqual(result.errors, []);
  assert.equal(result.officialEssayCount, 2);
  assert.equal(result.catalogEssayCount, 2);

  await rm(root, { recursive: true, force: true });
});

function source(sourceKey: string, title: string, provenanceUrl: string) {
  return {
    source_key: sourceKey,
    title,
    creator: "Paul Graham",
    source_type: "essay",
    origin_class: "primary",
    language_code: "en",
    access_model: "free",
    acquisition_status: "discovered",
    priority: "high",
    provenance_url: provenanceUrl
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
