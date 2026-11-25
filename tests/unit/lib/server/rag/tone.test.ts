import assert from "node:assert/strict";
import test from "node:test";
import { detectReplyLanguage } from "../../../../../lib/server/rag/service.ts";
import { applyToneDirectives } from "../../../../../lib/server/rag/tone.ts";

test("detectReplyLanguage follows the user's message language over chat locale", () => {
  assert.equal(detectReplyLanguage("How do I stop worrying?", "ru"), "en");
  assert.equal(detectReplyLanguage("Как перестать тревожиться?", "en"), "ru");
});

test("applyToneDirectives adds dossier tone only for matching conversational prompts", () => {
  const reply = applyToneDirectives({
    userBody: "hello",
    rawReply: "Attend to what is yours to govern.",
    tone: {
      voice: "plain",
      cadence: "brief",
      do: ['greet with "Salve"'],
      avoid: []
    }
  });

  assert.equal(reply, "Salve. Attend to what is yours to govern.");
});
