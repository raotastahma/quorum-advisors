import { readFile } from "node:fs/promises";
import type { ChatModelAdapter, ChatRepository, RetrievedFragment } from "../lib/server/chats/types.ts";
import type { ServerConfig } from "../lib/server/config.ts";
import { RagService } from "../lib/server/rag/service.ts";

export const DEMO_ADVISOR_ID = "demo-mentor";
export const DEMO_CONFIG: ServerConfig = {
  telegramBotToken: "unused-offline-demo",
  telegramWebhookSecret: "unused-offline-demo",
  supabaseUrl: "https://example.invalid",
  supabaseSecretKey: "unused-offline-demo"
};

// Deterministic topic-count vectors make retrieval inspectable without a model service.
// shortcut: these vectors demonstrate the adapter contract, not semantic embedding quality.
export function embedText(text: string): number[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return [
    ["learn", "learning", "skill", "experiment", "experiments"],
    ["feedback", "confusing", "learner", "observe", "change"],
    ["rest", "pause", "session", "return", "focused"]
  ].map((topic) => words.filter((word) => topic.includes(word)).length);
}

function similarity(a: number[], b: number[]): number {
  const scale = Math.hypot(...a) * Math.hypot(...b);
  return scale ? a.reduce((sum, value, index) => sum + value * b[index]!, 0) / scale : 0;
}

export async function createDemoRuntime() {
  const source = await readFile(new URL("../advisors/demo-mentor/corpus/source.txt", import.meta.url), "utf8");
  const fragments: RetrievedFragment[] = source.trim().split(/\n\n/).map((text, index) => ({
    id: `demo-fragment-${index + 1}`,
    fragmentIndex: index,
    originalText: text,
    retrievalTextEn: text,
    originalLanguageCode: "en",
    sourceKey: "original-demo-notes",
    documentTitle: "Original Demo Notes",
    similarityScore: null
  }));
  const unavailable = async (): Promise<never> => { throw new Error("This read-only demo does not persist chats."); };
  const repository: ChatRepository = {
    getChat: unavailable,
    listMessages: unavailable,
    prepareTurn: unavailable,
    finalizeTurn: unavailable,
    async getCurrentDossier(_config, advisorId) {
      if (advisorId !== DEMO_ADVISOR_ID) return null;
      return {
        id: "demo-dossier", version: 1,
        tone: { voice: "plain", cadence: "brief", do: ['greet with "Welcome"'], avoid: [] },
        redLines: ["Do not claim to be a real person."],
        coreIdeas: ["Learn through observations."], argumentPatterns: [], secondaryContextNotes: []
      };
    },
    async matchApprovedFragments(_config, input) {
      if (input.advisorId !== DEMO_ADVISOR_ID) return [];
      return fragments.map((fragment) => ({
        ...fragment, similarityScore: similarity(input.queryEmbedding, embedText(fragment.retrievalTextEn))
      })).filter((fragment) => fragment.similarityScore > 0)
        .sort((a, b) => b.similarityScore - a.similarityScore)
        .slice(0, input.limit);
    }
  };
  const model: ChatModelAdapter = {
    async translateToEnglish() { throw new Error("The offline demo supports English input only."); },
    async createEmbedding(text) { return embedText(text); },
    async generateAdvisorReply(input) {
      return { modelName: "deterministic-demo-adapter", text: input.fragments[0]!.originalText };
    }
  };
  return { service: new RagService(repository, model, { retrievalLimit: 2 }), repository, fragments };
}

export async function askDemo(question: string) {
  const { service } = await createDemoRuntime();
  return service.generateReply(DEMO_CONFIG, {
    advisorId: DEMO_ADVISOR_ID, advisorDisplayName: "Demo Mentor",
    userBody: question, chatLocale: "en", conversation: []
  });
}
