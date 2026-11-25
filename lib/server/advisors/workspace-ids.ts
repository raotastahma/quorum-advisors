import { createHash } from "node:crypto";

const UUID_NAMESPACE = "quorum-advisor-workspace-v1";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function workspaceSourceId(advisorSlug: string, sourceKey: string): string {
  return stableUuid("advisor-source", advisorSlug, sourceKey);
}

export function workspaceDocumentId(advisorSlug: string, sourceKey: string): string {
  return stableUuid("corpus-document", advisorSlug, sourceKey);
}

export function workspaceFragmentId(
  advisorSlug: string,
  sourceKey: string,
  fragmentIndex: number
): string {
  return stableUuid("corpus-fragment", advisorSlug, sourceKey, String(fragmentIndex));
}

function stableUuid(kind: string, ...parts: string[]): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify([UUID_NAMESPACE, kind, ...parts]))
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}
