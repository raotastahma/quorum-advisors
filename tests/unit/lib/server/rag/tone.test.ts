import assert from "node:assert/strict";
import test from "node:test";
import { RagService, detectReplyLanguage } from "../../../../../lib/server/rag/service.ts";
import { withoutLegacyGreetingRules, withMarcusDialogueOpening } from "../../../../../lib/server/rag/tone.ts";
import { SupabaseChatRepository } from "../../../../../lib/server/chats/repository.ts";
import { OpenAiChatModel } from "../../../../../lib/server/model/openai.ts";
import type { AdvisorDossierRecord, ChatModelAdapter, ChatRepository } from "../../../../../lib/server/chats/types.ts";
import type { ServerConfig } from "../../../../../lib/server/config.ts";

const legacyDossier: AdvisorDossierRecord = {
  id: "legacy-dossier", version: 1, advisorSlug: "marcus-aurelius",
  tone: {
    voice: "Measured and practical", cadence: "Brief reflections",
    do: ["Lead with calm moral clarity.", "If a reply naturally includes a greeting, greet with 'Salve'; if it naturally includes a farewell or sign-off, use 'Vale'.", "Keep phrasing plain."],
    avoid: ["Do not force a greeting or sign-off into every answer; use 'Salve' and 'Vale' only when that framing fits the reply.", "Do not invent quotations."]
  },
  coreIdeas: ["Attend to your judgment."], argumentPatterns: ["Separate events from judgments."],
  redLines: ["Do not claim to be the historical person."], secondaryContextNotes: []
};
const fragment = { id: "fragment", fragmentIndex: 0, originalText: "Work with what is within your control.", retrievalTextEn: "Work with what is within your control.", originalLanguageCode: "en", sourceKey: "original-note", documentTitle: "Original note", similarityScore: 1 };
const config: ServerConfig = { telegramBotToken: "unused", telegramWebhookSecret: "unused", supabaseUrl: "https://example.invalid", supabaseSecretKey: "unused" };

test("detectReplyLanguage follows the user's message language over chat locale", () => {
  assert.equal(detectReplyLanguage("How do I stop worrying?", "ru"), "en");
  assert.equal(detectReplyLanguage("Как перестать тревожиться?", "en"), "ru");
});

test("legacy greeting instructions are omitted while ordinary tone guidance and stored data are preserved", () => {
  const before = structuredClone(legacyDossier);
  assert.deepEqual(withoutLegacyGreetingRules(legacyDossier.tone, "marcus-aurelius"), {
    voice: "Measured and practical", cadence: "Brief reflections",
    do: ["Lead with calm moral clarity.", "Keep phrasing plain."], avoid: ["Do not invent quotations."]
  });
  assert.deepEqual(legacyDossier, before);
  assert.deepEqual(withoutLegacyGreetingRules(legacyDossier.tone, "another-advisor"), legacyDossier.tone);
  assert.deepEqual(withoutLegacyGreetingRules({ voice: "plain", cadence: "brief", do: ["Discuss the meanings of Salve and Vale."], avoid: [] }, "marcus-aurelius").do,
    ["Discuss the meanings of Salve and Vale."]);
});

for (const [userBody, rawReply] of [
  ["Hello, how should I approach today?", "Hello. Take one practical step."],
  ["Goodbye for now.", "Goodbye. Return when you wish."],
  ["Привет!", "Здравствуйте. Чем могу помочь?"],
  ["Please explain Salve and Vale.", "Salve and Vale are Latin expressions."],
  ["A greeting and farewell, please.", "Salve. Attend to your duties. Vale."]
]) {
  test(`RAG preserves the model's natural reply for ${userBody}`, async () => {
    const unused = async (): Promise<never> => { throw new Error("Not used in reply generation"); };
    const repository: ChatRepository = {
      getChat: unused, listMessages: unused, prepareTurn: unused, finalizeTurn: unused,
      async getCurrentDossier() { return legacyDossier; }, async matchApprovedFragments() { return [fragment]; }
    };
    const model: ChatModelAdapter = {
      async translateToEnglish(text) { return text; }, async createEmbedding() { return [1]; },
      async generateAdvisorReply(input) {
        assert.equal(input.userBody, userBody);
        assert.equal(input.dossier.tone.voice, legacyDossier.tone.voice);
        assert.doesNotMatch(input.dossier.tone.do.join(" "), /greet with/);
        assert.doesNotMatch(input.dossier.tone.avoid.join(" "), /use 'Salve'/);
        return { text: `  ${rawReply}  `, modelName: "offline-test" };
      }
    };
    const reply = await new RagService(repository, model).generateReply(config, {
      advisorId: "advisor", advisorDisplayName: "Advisor", userBody, chatLocale: "en", conversation: []
    });
    assert.equal(reply.replyText, rawReply);
  });
}

test("actual model request excludes legacy directives from instructions and raw context without censoring user text", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "offline-placeholder";
  t.after(() => { if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; });
  let request: { instructions: string; input: string } | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "Salve. Ordinary model wording. Vale." }] }] }), { status: 200 });
  });
  const result = await new OpenAiChatModel().generateAdvisorReply({
    advisorDisplayName: "Advisor", userBody: "Explain Salve and Vale.", replyLanguage: "en", chatLocale: "ru",
    conversation: [], dossier: legacyDossier, fragments: [fragment]
  });
  assert.ok(request);
  assert.doesNotMatch(request.instructions, /Salve|Vale|greet with/);
  assert.match(request.instructions, /Lead with calm moral clarity/);
  assert.match(request.instructions, /Reply language: English/);
  assert.match(request.instructions, /Chat locale: ru/);
  assert.match(request.input, /User message: Explain Salve and Vale\./);
  assert.doesNotMatch(request.input, /use 'Salve'|greet with/);
  assert.equal(result.text, "Salve. Ordinary model wording. Vale.");
});


test("opening formatter localizes and deduplicates only leading Roman greetings", () => {
  assert.equal(withMarcusDialogueOpening("Marcus Aurelius: sAlVe, A useful step.", "ru", "Marcus Aurelius"), "Marcus Aurelius: Сальве. A useful step.");
  assert.equal(withMarcusDialogueOpening("САЛЬВЕ! Salve. A useful step.", "en", "Marcus Aurelius"), "Marcus Aurelius: Salve. A useful step.");
  assert.equal(withMarcusDialogueOpening("Salve means hello.", "en", "Marcus Aurelius"), "Marcus Aurelius: Salve. Salve means hello.");
  assert.equal(withMarcusDialogueOpening("Salverson asked about Vale.", "en", "Marcus Aurelius"), "Marcus Aurelius: Salve. Salverson asked about Vale.");
});


test("persisted dossier lookup carries the stored advisor slug without rewriting the historical payload", async (t) => {
  for (const slug of ["marcus-aurelius", "another-advisor"]) {
    t.mock.method(globalThis, "fetch", async (url: URL) => {
      assert.match(url.searchParams.get("select") ?? "", /advisors!inner\(slug\)/);
      assert.equal(url.searchParams.get("advisor_id"), "eq.advisor");
      return Response.json([{ id: "legacy", version: 1, advisors: { slug }, payload: { tone: legacyDossier.tone } }]);
    });
    const stored = await new SupabaseChatRepository().getCurrentDossier(config, "advisor");
    assert.equal(stored?.advisorSlug, slug);
    assert.deepEqual(stored?.tone, legacyDossier.tone);
    const normalized = withoutLegacyGreetingRules(stored!.tone, stored!.advisorSlug);
    assert.equal(normalized.do.length, slug === "marcus-aurelius" ? 2 : 3);
    t.mock.restoreAll();
  }
});
