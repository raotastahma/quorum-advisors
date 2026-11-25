export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string | null;
  username?: string | null;
  language_code?: string | null;
  is_premium?: boolean;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from: TelegramUser;
  text: string;
  entities?: TelegramMessageEntity[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export function parseTelegramUpdate(value: unknown): TelegramUpdate | null {
  if (!isRecord(value) || !isTelegramInteger(value.update_id)) {
    return null;
  }

  return {
    update_id: value.update_id,
    message: parseTelegramMessage(value.message)
  };
}

export function isSupportedPrivateTextUpdate(
  update: TelegramUpdate
): update is TelegramUpdate & { message: TelegramMessage } {
  const message = update.message;

  return (
    message !== undefined &&
    Number.isSafeInteger(message.message_id) &&
    Number.isSafeInteger(message.chat.id) &&
    message.chat.type === "private" &&
    Number.isSafeInteger(message.from.id) &&
    message.from.is_bot === false &&
    message.from.first_name.trim() !== "" &&
    message.text.trim() !== ""
  );
}

function parseTelegramMessage(value: unknown): TelegramMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const chat = parseTelegramChat(value.chat);
  const from = parseTelegramUser(value.from);

  if (
    !isTelegramInteger(value.message_id) ||
    !chat ||
    !from ||
    typeof value.text !== "string"
  ) {
    return undefined;
  }

  return {
    message_id: value.message_id,
    date: isTelegramInteger(value.date) ? value.date : undefined,
    chat,
    from,
    text: value.text,
    entities: parseTelegramEntities(value.entities)
  };
}

function parseTelegramChat(value: unknown): TelegramChat | null {
  if (!isRecord(value) || !isTelegramInteger(value.id) || typeof value.type !== "string") {
    return null;
  }

  return {
    id: value.id,
    type: value.type
  };
}

function parseTelegramUser(value: unknown): TelegramUser | null {
  if (
    !isRecord(value) ||
    !isTelegramInteger(value.id) ||
    typeof value.is_bot !== "boolean" ||
    typeof value.first_name !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    is_bot: value.is_bot,
    first_name: value.first_name,
    last_name: nullableString(value.last_name),
    username: nullableString(value.username),
    language_code: nullableString(value.language_code),
    is_premium: typeof value.is_premium === "boolean" ? value.is_premium : undefined
  };
}

function parseTelegramEntities(value: unknown): TelegramMessageEntity[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entities = value.flatMap((entity): TelegramMessageEntity[] => {
    if (
      isRecord(entity) &&
      typeof entity.type === "string" &&
      isTelegramInteger(entity.offset) &&
      isTelegramInteger(entity.length)
    ) {
      return [
        {
          type: entity.type,
          offset: entity.offset,
          length: entity.length
        }
      ];
    }

    return [];
  });

  return entities.length > 0 ? entities : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTelegramInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  return typeof value === "string" ? value : undefined;
}
