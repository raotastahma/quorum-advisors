import { readFile } from "node:fs/promises";
import path from "node:path";

export const PAUL_GRAHAM_INDEX_URL = "https://www.paulgraham.com/articles.html";
const PAUL_GRAHAM_WORKSPACE = path.join(process.cwd(), "advisors", "paul-graham");
const REQUIRED_SOURCE_FIELDS = [
  "source_key",
  "title",
  "creator",
  "source_type",
  "origin_class",
  "language_code",
  "access_model",
  "acquisition_status",
  "priority",
  "provenance_url"
] as const;
const FULL_TEXT_FIELDS = new Set([
  "body",
  "content",
  "essay_text",
  "full_text",
  "normalized_text",
  "raw_text",
  "retrieval_text_en",
  "text"
]);

type JsonObject = Record<string, unknown>;

export type PaulGrahamEssayLink = {
  title: string;
  url: string;
  sourceKey: string;
};

export type PaulGrahamCatalogCheck = {
  officialIndexUrl: string;
  officialEssayCount: number;
  catalogEssayCount: number;
  errors: string[];
};

export function parsePaulGrahamEssayIndex(
  html: string,
  indexUrl = PAUL_GRAHAM_INDEX_URL
): PaulGrahamEssayLink[] {
  const links = new Map<string, PaulGrahamEssayLink>();
  const anchorRe = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRe)) {
    const href = decodeHtml(match[2] ?? "").trim();
    const title = normalizeTitle(stripTags(decodeHtml(match[3] ?? "")));

    if (!href || !title || title.toLowerCase() === "rss" || title.toLowerCase() === "feed") {
      continue;
    }

    const url = normalizeUrl(href, indexUrl);

    if (!isPaulGrahamEssayUrl(url)) {
      continue;
    }

    links.set(url, { title, url, sourceKey: sourceKeyFromUrl(url) });
  }

  return [...links.values()];
}

export async function verifyPaulGrahamSourceCatalog(
  workspacePath = PAUL_GRAHAM_WORKSPACE,
  indexHtml?: string
): Promise<PaulGrahamCatalogCheck> {
  const officialLinks = parsePaulGrahamEssayIndex(
    indexHtml ?? (await fetchOfficialIndexHtml()),
    PAUL_GRAHAM_INDEX_URL
  );
  const advisor = await readJson(path.join(workspacePath, "advisor.json"));
  const catalog = await readJson(path.join(workspacePath, "source-catalog.json"));
  const sources = Array.isArray(catalog.sources) ? catalog.sources : [];
  const errors: string[] = [];

  if (advisor.telegram_command !== "paul_graham") {
    errors.push("advisor.json.telegram_command must be paul_graham");
  }

  if ("telegram_commands" in advisor || "aliases" in advisor || "alias_commands" in advisor) {
    errors.push("advisor.json must not define advisor alias command values");
  }

  if (officialLinks.length === 0) {
    errors.push("official Paul Graham essay index did not contain any essay links");
  }

  if (!Array.isArray(catalog.sources)) {
    errors.push("source-catalog.json.sources must be an array");
  }

  const officialByTitle = new Map(officialLinks.map((link) => [link.title, link]));
  const officialTitles = new Set(officialByTitle.keys());
  const catalogTitles = new Set<string>();
  const sourceKeys = new Set<string>();

  sources.forEach((source, index) => {
    if (!isObject(source)) {
      errors.push(`source-catalog.json.sources[${index}] must be an object`);
      return;
    }

    for (const field of REQUIRED_SOURCE_FIELDS) {
      if (!isNonEmptyString(source[field])) {
        errors.push(`source-catalog.json.sources[${index}].${field} must be a non-empty string`);
      }
    }

    for (const field of Object.keys(source)) {
      if (FULL_TEXT_FIELDS.has(field)) {
        errors.push(`source-catalog.json.sources[${index}].${field} must not expose full essay text`);
      }
    }

    if (source.creator !== "Paul Graham") {
      errors.push(`source-catalog.json.sources[${index}].creator must be Paul Graham`);
    }

    if (source.source_type !== "essay") {
      errors.push(`source-catalog.json.sources[${index}].source_type must be essay`);
    }

    if (source.origin_class !== "primary") {
      errors.push(`source-catalog.json.sources[${index}].origin_class must be primary`);
    }

    if (source.access_model !== "free") {
      errors.push(`source-catalog.json.sources[${index}].access_model must be free`);
    }

    const sourceKey = String(source.source_key ?? "");
    const title = String(source.title ?? "");
    const provenanceUrl = isNonEmptyString(source.provenance_url)
      ? normalizeUrl(source.provenance_url, PAUL_GRAHAM_INDEX_URL)
      : "";

    if (sourceKeys.has(sourceKey)) {
      errors.push(`source-catalog.json.sources[${index}].source_key is duplicated`);
    }

    if (catalogTitles.has(title)) {
      errors.push(`source-catalog.json.sources[${index}].title is duplicated`);
    }

    const officialLink = officialByTitle.get(title);

    if (officialLink && provenanceUrl !== officialLink.url) {
      errors.push(
        `source-catalog.json.sources[${index}].provenance_url must match official essay URL ${officialLink.url}`
      );
    }

    sourceKeys.add(sourceKey);
    catalogTitles.add(title);
  });

  for (const title of officialTitles) {
    if (!catalogTitles.has(title)) {
      errors.push(`source-catalog.json is missing official essay: ${title}`);
    }
  }

  for (const title of catalogTitles) {
    if (!officialTitles.has(title)) {
      errors.push(`source-catalog.json contains non-index essay: ${title}`);
    }
  }

  return {
    officialIndexUrl: PAUL_GRAHAM_INDEX_URL,
    officialEssayCount: officialTitles.size,
    catalogEssayCount: sources.length,
    errors
  };
}

async function fetchOfficialIndexHtml(): Promise<string> {
  const response = await fetch(PAUL_GRAHAM_INDEX_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${PAUL_GRAHAM_INDEX_URL}: ${response.status}`);
  }

  return await response.text();
}

async function readJson(filePath: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(value)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return value;
}

function normalizeUrl(href: string, indexUrl: string): string {
  const url = new URL(href, indexUrl);

  url.hash = "";
  url.search = "";

  if (url.protocol === "http:") {
    url.protocol = "https:";
  }

  if (url.hostname === "paulgraham.com") {
    url.hostname = "www.paulgraham.com";
  }

  return url.toString();
}

function isPaulGrahamEssayUrl(url: string): boolean {
  const parsed = new URL(url);

  if (parsed.hostname === "www.paulgraham.com") {
    return parsed.pathname !== "/articles.html" && parsed.pathname !== "/rss.html";
  }

  return parsed.hostname === "sep.turbifycdn.com";
}

function sourceKeyFromUrl(url: string): string {
  const parsed = new URL(url);
  const basename = path.basename(parsed.pathname).replace(/\.[^.]+$/, "");
  const key = basename.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return `pg-${key}`;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
