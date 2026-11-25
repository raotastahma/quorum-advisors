import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPaulGrahamLaunchEvidence,
  paulGrahamLaunchActivationSql,
  readH006LaunchDecision,
  readPaulGrahamBenchmarkPassedAt
} from "../../../lib/server/advisors/paul-graham-launch.ts";

const HUMAN_GO = `
### H-006 -- Review Paul Graham readiness packet and approve launch-enabled state

- Instructions mention go/no-go review.

- Completion Record:
  - \`2026-04-29\`: Human owner reviewed the Paul Graham readiness state and recorded a \`go\` approval for launch-enabling Paul Graham after \`QRM-042\`.
`;

test("builds Paul Graham launch evidence from H-006 go and passing packet", () => {
  const evidence = buildPaulGrahamLaunchEvidence(HUMAN_GO, passingPacket());

  assert.deepEqual(evidence, {
    h006Decision: "go",
    benchmarkPassedAt: "2026-04-29T16:07:22.718Z"
  });

  assert.equal(
    paulGrahamLaunchActivationSql(evidence),
    [
      "select *",
      "from public.quorum_enable_paul_graham_launch(",
      "  'go',",
      "  '2026-04-29T16:07:22.718Z'::timestamptz",
      ");"
    ].join("\n")
  );
});

test("refuses Paul Graham launch evidence when H-006 has no go approval", () => {
  assert.equal(
    readH006LaunchDecision(`
### H-006 -- Review Paul Graham readiness packet and approve launch-enabled state

- Completion Record:
  - \`2026-04-29\`: Human owner recorded a \`no-go\` approval.
`),
    "no-go"
  );

  assert.throws(
    () =>
      buildPaulGrahamLaunchEvidence(
        "### H-006 -- Review Paul Graham readiness packet\n\n- Completion Record:\n  - Pending.",
        passingPacket()
      ),
    /H-006 launch decision is not go/
  );
});

test("requires a ready Paul Graham packet with benchmark generated_at", () => {
  assert.equal(readPaulGrahamBenchmarkPassedAt(passingPacket()), "2026-04-29T16:07:22.718Z");

  assert.throws(
    () =>
      readPaulGrahamBenchmarkPassedAt({
        ...passingPacket(),
        checks: [{ key: "benchmark_run_evidence", status: "fail" }]
      }),
    /must have only passing checks/
  );
});

function passingPacket() {
  return {
    advisor_slug: "paul-graham",
    recommendation: "ready_for_human_go",
    checks: [
      {
        key: "benchmark_run_evidence",
        status: "pass",
        evidence: {
          generated_at: "2026-04-29T16:07:22.718Z"
        }
      }
    ],
    benchmark_run_evidence: {
      passed: true
    }
  };
}
