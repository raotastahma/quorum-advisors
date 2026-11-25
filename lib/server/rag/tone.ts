import type { ChatLocale, ToneInstructions } from "../chats/types.ts";

// Compatibility for the retired curator rules in already-published dossier versions.
// Only instruction entries are normalized; user messages, source text and replies are untouched.
export function isRetiredGreetingDirective(value: string): boolean {
  return /(greet with ['"]salve['"]|(?:farewell|sign-off).*use ['"]vale['"]|use ['"]salve['"] and ['"]vale['"])/i.test(value);
}

export function withoutLegacyGreetingRules(tone: ToneInstructions, advisorSlug?: string): ToneInstructions {
  if (advisorSlug !== "marcus-aurelius") return tone;
  return {
    ...tone,
    do: tone.do.filter((rule) => !isRetiredGreetingDirective(rule)),
    avoid: tone.avoid.filter((rule) => !isRetiredGreetingDirective(rule))
  };
}

// Called only after the database confirms this is Marcus's true dialogue opening.
export function withMarcusDialogueOpening(text: string, locale: ChatLocale, displayName: string): string {
  const prefix = displayName + ":";
  let body = text.trim();
  if (body.startsWith(prefix)) body = body.slice(prefix.length).trimStart();
  const opening = /^(?:salve|сальве)(?=$|[\r\n,.:;!?])(?:[\s,.:;!?])*/iu;
  while (opening.test(body)) body = body.replace(opening, "");
  return prefix + " " + (locale === "ru" ? "Сальве" : "Salve") + "." + (body ? " " + body : "");
}

// Preserve existing curator tone behavior for advisors other than Marcus.
const GREETING_PATTERNS = [
  /\bhello\b/i,
  /\bhi\b/i,
  /\bhey\b/i,
  /\bgreetings\b/i,
  /\bgood (morning|afternoon|evening)\b/i,
  /привет/i,
  /здравствуй(?:те)?/i,
  /добрый (день|вечер|утро)/i
];

const FAREWELL_PATTERNS = [
  /\bbye\b/i,
  /\bgoodbye\b/i,
  /\bfarewell\b/i,
  /\bsee you\b/i,
  /до свидания/i,
  /пока/i,
  /прощай(?:те)?/i
];

export function applyToneDirectives(input: {
  userBody: string;
  rawReply: string;
  tone: ToneInstructions;
  advisorSlug?: string;
}): string {
  let reply = input.rawReply.trim();

  if (input.advisorSlug === "marcus-aurelius") return reply;

  if (reply.length === 0) {
    return reply;
  }

  const greetingToken = extractQuotedDirective(input.tone.do, /greet with ['"]([^'"]+)['"]/i);
  const farewellToken = extractQuotedDirective(
    input.tone.do,
    /(?:farewell|sign-off)[^'"]*use ['"]([^'"]+)['"]/i
  );

  if (greetingToken && isGreetingPrompt(input.userBody) && !containsToken(reply, greetingToken)) {
    reply = `${greetingToken}. ${reply}`;
  }

  if (farewellToken && isFarewellPrompt(input.userBody) && !containsToken(reply, farewellToken)) {
    reply = `${reply} ${farewellToken}.`.replace(/\.\s+\./g, ".");
  }

  return reply;
}

function extractQuotedDirective(items: string[], pattern: RegExp): string | null {
  for (const item of items) {
    const match = item.match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function containsToken(value: string, token: string): boolean {
  return value.toLowerCase().includes(token.toLowerCase());
}

function isGreetingPrompt(value: string): boolean {
  return GREETING_PATTERNS.some((pattern) => pattern.test(value));
}

function isFarewellPrompt(value: string): boolean {
  return FAREWELL_PATTERNS.some((pattern) => pattern.test(value));
}
