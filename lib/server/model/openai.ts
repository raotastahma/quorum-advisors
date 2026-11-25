import { withoutLegacyGreetingRules } from "../rag/tone.ts";
import { UpstreamUnavailableError } from "../supabase.ts";
import type {
  AdvisorDossierRecord,
  ChatLocale,
  ChatMessageRecord,
  ChatModelAdapter,
  RetrievedFragment
} from "../chats/types.ts";

type ResponsesApiResult = {
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

type EmbeddingApiResult = {
  data?: Array<{
    embedding?: number[];
  }>;
};

export class OpenAiChatModel implements ChatModelAdapter {
  async translateToEnglish(text: string): Promise<string> {
    const config = openAiConfig();
    const response = await createResponse(config, {
      instructions:
        "Translate the user's message into English for retrieval. Return only the English translation.",
      input: text
    });

    return extractOutputText(response);
  }

  async createEmbedding(text: string): Promise<number[]> {
    const config = openAiConfig();
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: text
      })
    });

    if (!response.ok) {
      throw new UpstreamUnavailableError(
        `OpenAI embeddings request failed with status ${response.status}.`
      );
    }

    const payload = (await response.json()) as EmbeddingApiResult;
    const embedding = payload.data?.[0]?.embedding;

    if (!embedding || embedding.length === 0) {
      throw new UpstreamUnavailableError("OpenAI embeddings response was empty.");
    }

    return embedding;
  }

  async generateAdvisorReply(input: {
    advisorDisplayName: string;
    userBody: string;
    replyLanguage: ChatLocale;
    chatLocale: ChatLocale;
    conversation: ChatMessageRecord[];
    dossier: AdvisorDossierRecord;
    fragments: RetrievedFragment[];
  }): Promise<{ modelName: string; text: string }> {
    const config = openAiConfig();
    const dossier = { ...input.dossier, tone: withoutLegacyGreetingRules(input.dossier.tone, input.dossier.advisorSlug) };
    const response = await createResponse(config, {
      instructions: buildAdvisorInstructions(
        dossier,
        input.replyLanguage,
        input.chatLocale,
        input.advisorDisplayName
      ),
      input: buildAdvisorInput(input.userBody, input.conversation, dossier, input.fragments)
    });

    return {
      modelName: config.chatModel,
      text: extractOutputText(response)
    };
  }
}

function openAiConfig(): { apiKey: string; chatModel: string; embeddingModel: string } {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new UpstreamUnavailableError("OPENAI_API_KEY is required for chat generation.");
  }

  return {
    apiKey,
    chatModel: process.env.OPENAI_MODEL?.trim() || "gpt-5-mini",
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small"
  };
}

async function createResponse(
  config: { apiKey: string; chatModel: string },
  input: { instructions: string; input: string }
): Promise<ResponsesApiResult> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.chatModel,
      instructions: input.instructions,
      input: input.input,
      text: {
        format: {
          type: "text"
        }
      }
    })
  });

  if (!response.ok) {
    throw new UpstreamUnavailableError(
      `OpenAI responses request failed with status ${response.status}.`
    );
  }

  return (await response.json()) as ResponsesApiResult;
}

function buildAdvisorInstructions(
  dossier: AdvisorDossierRecord,
  replyLanguage: ChatLocale,
  chatLocale: ChatLocale,
  advisorDisplayName: string
): string {
  return [
    `You are producing one synchronous chat reply for Quorum's ${advisorDisplayName} advisor.`,
    `Start the reply with exactly "${advisorDisplayName}:".`,
    `Reply language: ${replyLanguage === "ru" ? "Russian" : "English"}.`,
    `Chat locale: ${chatLocale}. Follow the language used by the user's message.`,
    "Use only the supplied approved dossier and approved retrieved fragments as grounding.",
    "Do not expose internal provenance, source access details, or grounding metadata.",
    `Do not claim to literally be ${advisorDisplayName} or an official estate representative.`,
    "Do not invent direct quotes, book references, or provenance.",
    `Voice: ${dossier.tone.voice}`,
    `Cadence: ${dossier.tone.cadence}`,
    `Do: ${dossier.tone.do.join(" | ")}`,
    `Avoid: ${dossier.tone.avoid.join(" | ")}`,
    `Red lines: ${dossier.redLines.join(" | ")}`
  ].join("\n");
}

function buildAdvisorInput(
  userBody: string,
  conversation: ChatMessageRecord[],
  dossier: AdvisorDossierRecord,
  fragments: RetrievedFragment[]
): string {
  const history = conversation
    .map((message) => `${message.role.toUpperCase()}: ${message.body}`)
    .join("\n");
  const fragmentSection = fragments
    .map(
      (fragment, index) =>
        `[${index + 1}] ${fragment.sourceKey} / ${fragment.documentTitle}\n${fragment.originalText}`
    )
    .join("\n\n");

  return [
    "Conversation history:",
    history || "(no previous messages)",
    "",
    "Dossier core ideas:",
    dossier.coreIdeas.join("\n"),
    "",
    "Dossier argument patterns:",
    dossier.argumentPatterns.join("\n"),
    "",
    "Dossier secondary context notes:",
    dossier.secondaryContextNotes.join("\n"),
    "",
    "Approved retrieved fragments:",
    fragmentSection,
    "",
    `User message: ${userBody}`
  ].join("\n");
}

function extractOutputText(response: ResponsesApiResult): string {
  const texts: string[] = [];

  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }

  const text = texts.join("\n").trim();

  if (text.length === 0) {
    throw new UpstreamUnavailableError("OpenAI response did not contain output text.");
  }

  return text;
}
