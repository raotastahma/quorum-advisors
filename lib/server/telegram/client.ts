import type { ServerConfig } from "../config.ts";
import { UpstreamUnavailableError } from "../supabase.ts";
import type { TelegramMessageEntity } from "./types.ts";

export interface TelegramSendMessagePayload {
  chat_id: number;
  text: string;
  entities?: TelegramMessageEntity[];
  link_preview_options: {
    is_disabled: true;
  };
}

export type TelegramSendMessageResult = {
  messageId: number | null;
};

export type TelegramSender = (
  config: ServerConfig,
  input: { chatId: number; text: string; entities?: TelegramMessageEntity[] }
) => Promise<TelegramSendMessageResult>;

export function buildSendMessagePayload(input: {
  chatId: number;
  text: string;
  entities?: TelegramMessageEntity[];
}): TelegramSendMessagePayload {
  return {
    chat_id: input.chatId,
    text: input.text,
    entities: input.entities,
    link_preview_options: {
      is_disabled: true
    }
  };
}

export function buildBoldPrefixEntity(displayName: string): TelegramMessageEntity {
  return {
    type: "bold",
    offset: 0,
    length: `${displayName}:`.length
  };
}

export async function sendTelegramMessage(
  config: ServerConfig,
  input: { chatId: number; text: string; entities?: TelegramMessageEntity[] }
): Promise<TelegramSendMessageResult> {
  const url = new URL(`/bot${config.telegramBotToken}/sendMessage`, "https://api.telegram.org");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(buildSendMessagePayload(input))
  });

  if (!response.ok) {
    throw new UpstreamUnavailableError(await response.text());
  }

  const payload = (await response.json()) as {
    result?: {
      message_id?: unknown;
    };
  };

  return {
    messageId:
      typeof payload.result?.message_id === "number" ? payload.result.message_id : null
  };
}
