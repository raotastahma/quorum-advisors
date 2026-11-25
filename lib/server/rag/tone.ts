import type { ToneInstructions } from "../chats/types.ts";

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
}): string {
  let reply = input.rawReply.trim();

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
