type JsonObject = Record<string, unknown>;

export type PaulGrahamLaunchEvidence = {
  h006Decision: "go";
  benchmarkPassedAt: string;
};

export function buildPaulGrahamLaunchEvidence(
  humanTasksMarkdown: string,
  launchPacket: unknown
): PaulGrahamLaunchEvidence {
  const h006Decision = readH006LaunchDecision(humanTasksMarkdown);

  if (h006Decision !== "go") {
    throw new Error("H-006 launch decision is not go; refusing to enable Paul Graham launch.");
  }

  return {
    h006Decision,
    benchmarkPassedAt: readPaulGrahamBenchmarkPassedAt(launchPacket)
  };
}

export function readH006LaunchDecision(markdown: string): "go" | "no-go" | null {
  const startIndex = markdown.search(/^### H-006 /m);

  if (startIndex === -1) {
    return null;
  }

  const rest = markdown.slice(startIndex);
  const nextSectionIndex = rest.search(/\n### H-\d+ /);
  const section = nextSectionIndex === -1 ? rest : rest.slice(0, nextSectionIndex);

  const completionRecord = section.split("Completion Record:").at(1) ?? section;

  if (
    /recorded\s+(?:an?\s+)?`?no-go`?\s+approval/i.test(completionRecord) ||
    /final launch decision:\s*`?no-go`?/i.test(completionRecord)
  ) {
    return "no-go";
  }

  if (
    /recorded\s+(?:an?\s+)?`?go`?\s+approval/i.test(completionRecord) ||
    /final launch decision:\s*`?go`?/i.test(completionRecord)
  ) {
    return "go";
  }

  return null;
}

export function readPaulGrahamBenchmarkPassedAt(packet: unknown): string {
  if (!isObject(packet)) {
    throw new Error("Paul Graham launch review packet must be a JSON object.");
  }

  if (packet.advisor_slug !== "paul-graham") {
    throw new Error("Paul Graham launch review packet has the wrong advisor_slug.");
  }

  if (packet.recommendation !== "ready_for_human_go") {
    throw new Error("Paul Graham launch review packet is not ready_for_human_go.");
  }

  const checks = Array.isArray(packet.checks) ? packet.checks : [];

  if (checks.length === 0 || checks.some((check) => !isObject(check) || check.status !== "pass")) {
    throw new Error("Paul Graham launch review packet must have only passing checks.");
  }

  const benchmarkEvidence = isObject(packet.benchmark_run_evidence)
    ? packet.benchmark_run_evidence
    : null;

  if (!benchmarkEvidence || benchmarkEvidence.passed !== true) {
    throw new Error("Paul Graham benchmark run evidence must be present and passed.");
  }

  const benchmarkCheck = checks.find(
    (check): check is JsonObject => isObject(check) && check.key === "benchmark_run_evidence"
  );
  const generatedAt = isObject(benchmarkCheck?.evidence)
    ? benchmarkCheck.evidence.generated_at
    : null;

  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error("Paul Graham benchmark run evidence must include generated_at.");
  }

  return new Date(generatedAt).toISOString();
}

export function paulGrahamLaunchActivationSql(evidence: PaulGrahamLaunchEvidence): string {
  return [
    "select *",
    "from public.quorum_enable_paul_graham_launch(",
    `  ${sqlString(evidence.h006Decision)},`,
    `  ${sqlString(evidence.benchmarkPassedAt)}::timestamptz`,
    ");"
  ].join("\n");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
