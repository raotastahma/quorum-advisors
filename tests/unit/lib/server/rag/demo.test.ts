import assert from "node:assert/strict";
import test from "node:test";
import { askDemo, createDemoRuntime, DEMO_ADVISOR_ID, DEMO_CONFIG, embedText } from "../../../../../demo/runtime.ts";

test("application RAG retrieves a relevant original fragment and applies dossier greeting", async () => {
  const result = await askDemo("Hello, how should I learn through experiments?");
  assert.equal(result.fragments[0]?.id, "demo-fragment-1");
  assert.match(result.replyText, /^Welcome\. Learning:/);
  assert.match(result.replyText, /small reversible experiment/);
});

test("changing the question changes the retrieved evidence", async () => {
  const result = await askDemo("Should I rest and pause after a focused session?");
  assert.equal(result.fragments[0]?.id, "demo-fragment-3");
  assert.match(result.replyText, /^Rest:/);
  assert.doesNotMatch(result.replyText, /Welcome/);
});

test("missing relevant evidence fails closed instead of inventing a reply", async () => {
  await assert.rejects(askDemo("astronomy telescope"), /No approved fragments/);
});

test("retrieval and dossier access remain scoped to one advisor", async () => {
  const { repository } = await createDemoRuntime();
  assert.equal(await repository.getCurrentDossier(DEMO_CONFIG, "another-advisor"), null);
  assert.deepEqual(await repository.matchApprovedFragments(DEMO_CONFIG, {
    advisorId: "another-advisor", queryEmbedding: embedText("learn"), limit: 2
  }), []);
  const matches = await repository.matchApprovedFragments(DEMO_CONFIG, {
    advisorId: DEMO_ADVISOR_ID, queryEmbedding: embedText("learn"), limit: 1
  });
  assert.equal(matches.length, 1);
});

test("offline demo explicitly rejects unsupported non-English translation", async () => {
  await assert.rejects(askDemo("Как учиться?"), /English input only/);
});
