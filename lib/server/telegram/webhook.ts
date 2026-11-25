import type { BotCommandDispatcher } from "../bot/dispatcher.ts";
import { defaultBotCommandDispatcher } from "../bot/dispatcher.ts";
import { getServerConfig, type ServerConfig } from "../config.ts";
import { type ApiErrorCode, jsonResponse, requestIdFrom } from "../http.ts";
import { postgrest, UpstreamUnavailableError } from "../supabase.ts";
import {
  isSupportedPrivateTextUpdate,
  parseTelegramUpdate,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser
} from "./types.ts";

type ReceiptStatus = "processing" | "processed" | "ignored" | "failed";

interface TelegramUpdateReceipt {
  update_id: number;
  status: ReceiptStatus;
  received_at: string;
}

interface AppUserRow {
  id: string;
}

export interface TelegramWebhookDependencies {
  dispatcher?: BotCommandDispatcher;
}

const WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const STALE_PROCESSING_RECEIPT_AGE_MS = 5 * 60 * 1000;

export async function handleTelegramWebhook(
  request: Request,
  dependencies: TelegramWebhookDependencies = {}
): Promise<Response> {
  const requestId = requestIdFrom(request);
  const config = getServerConfig();

  if (request.headers.get(WEBHOOK_SECRET_HEADER) !== config.telegramWebhookSecret) {
    return telegramErrorResponse("UNAUTHORIZED", 401, requestId);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return telegramErrorResponse("VALIDATION_ERROR", 422, requestId);
  }

  const update = parseTelegramUpdate(body);

  if (!update) {
    return telegramErrorResponse("VALIDATION_ERROR", 422, requestId);
  }

  try {
    const receiptResult = await insertUpdateReceipt(config, update);

    if (!receiptResult.isNew) {
      if (isStaleProcessingReceipt(receiptResult.receipt)) {
        await finalizeExistingReceipt(config, update.update_id, {
          status: "failed",
          errorCode: "STALE_PROCESSING_DRAINED"
        });
      }

      return jsonResponse({ ok: true }, { status: 200, requestId });
    }

    if (!isSupportedPrivateTextUpdate(update)) {
      await finalizeExistingReceipt(config, update.update_id, {
        status: "ignored",
        errorCode: "UNSUPPORTED_UPDATE"
      });

      return jsonResponse({ ok: true }, { status: 200, requestId });
    }

    let user: AppUserRow | undefined;

    try {
      user = await upsertTelegramUser(config, update.message.from);
      const dispatchResult = await (
        dependencies.dispatcher ?? defaultBotCommandDispatcher
      ).dispatch(config, {
        userId: user.id,
        message: update.message
      });

      await finalizeExistingReceipt(config, update.update_id, {
        status: "processed",
        userId: user.id,
        chatId: dispatchResult.chatId,
        turnId: dispatchResult.turnId,
        message: update.message
      });
    } catch {
      await finalizeExistingReceipt(config, update.update_id, {
        status: "failed",
        userId: user?.id,
        errorCode: "DOWNSTREAM_PROCESSING_FAILED",
        message: update.message
      });
    }

    return jsonResponse({ ok: true }, { status: 200, requestId });
  } catch (error) {
    if (error instanceof UpstreamUnavailableError) {
      return telegramErrorResponse("UPSTREAM_UNAVAILABLE", 503, requestId);
    }

    throw error;
  }
}

function telegramErrorResponse(code: ApiErrorCode, status: number, requestId: string): Response {
  return jsonResponse(
    {
      ok: false,
      error: {
        code,
        message: telegramErrorMessage(code),
        requestId
      }
    },
    { status, requestId }
  );
}

function telegramErrorMessage(code: ApiErrorCode): string {
  if (code === "UNAUTHORIZED") {
    return "Webhook secret is invalid.";
  }

  if (code === "VALIDATION_ERROR") {
    return "Telegram update payload is invalid.";
  }

  return "Persistence is temporarily unavailable.";
}

function isStaleProcessingReceipt(receipt: TelegramUpdateReceipt): boolean {
  if (receipt.status !== "processing") {
    return false;
  }

  return Date.now() - Date.parse(receipt.received_at) >= STALE_PROCESSING_RECEIPT_AGE_MS;
}

async function insertUpdateReceipt(
  config: ServerConfig,
  update: TelegramUpdate
): Promise<{ isNew: boolean; receipt: TelegramUpdateReceipt }> {
  try {
    const rows = await postgrest<TelegramUpdateReceipt[]>(config, {
      method: "POST",
      path: "telegram_update_receipts",
      prefer: "return=representation",
      body: {
        update_id: update.update_id,
        telegram_chat_id: update.message?.chat.id ?? null,
        telegram_message_id: update.message?.message_id ?? null
      }
    });
    const receipt = rows[0];

    if (!receipt) {
      throw new UpstreamUnavailableError("Receipt insert returned no row.");
    }

    return {
      isNew: true,
      receipt
    };
  } catch (error) {
    const existingReceipt = await findUpdateReceipt(config, update.update_id);

    if (existingReceipt) {
      return {
        isNew: false,
        receipt: existingReceipt
      };
    }

    throw error;
  }
}

async function findUpdateReceipt(
  config: ServerConfig,
  updateId: number
): Promise<TelegramUpdateReceipt | null> {
  const rows = await postgrest<TelegramUpdateReceipt[]>(config, {
    path: "telegram_update_receipts",
    query: {
      update_id: `eq.${updateId}`,
      select: "update_id,status,received_at",
      limit: "1"
    }
  });

  return rows[0] ?? null;
}

async function upsertTelegramUser(
  config: ServerConfig,
  telegramUser: TelegramUser
): Promise<AppUserRow> {
  const rows = await postgrest<AppUserRow[]>(config, {
    method: "POST",
    path: "app_users",
    query: {
      on_conflict: "telegram_user_id"
    },
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      telegram_user_id: telegramUser.id,
      telegram_username: telegramUser.username ?? null,
      first_name: telegramUser.first_name,
      last_name: telegramUser.last_name ?? null,
      language_code: telegramUser.language_code ?? null,
      is_premium: telegramUser.is_premium ?? false,
      last_seen_at: new Date().toISOString()
    }
  });
  const row = rows[0];

  if (!row) {
    throw new UpstreamUnavailableError("Telegram user upsert returned no row.");
  }

  return row;
}

async function updateReceiptStatus(
  config: ServerConfig,
  updateId: number,
  input: {
    status: Exclude<ReceiptStatus, "processing">;
    userId?: string;
    chatId?: string | null;
    turnId?: string | null;
    errorCode?: string;
    message?: TelegramMessage;
  }
): Promise<void> {
  await postgrest<unknown>(config, {
    method: "PATCH",
    path: "telegram_update_receipts",
    query: {
      update_id: `eq.${updateId}`
    },
    body: {
      status: input.status,
      user_id: input.userId,
      telegram_chat_id: input.message?.chat.id,
      telegram_message_id: input.message?.message_id,
      processed_chat_id: input.chatId,
      processed_turn_id: input.turnId,
      error_code: input.errorCode,
      processed_at: new Date().toISOString()
    }
  });
}

async function finalizeExistingReceipt(
  config: ServerConfig,
  updateId: number,
  input: Parameters<typeof updateReceiptStatus>[2]
): Promise<void> {
  try {
    await updateReceiptStatus(config, updateId, input);
  } catch {
    // Receipt persistence is the Telegram retry boundary. Stale processing
    // receipt checks surface failed finalization separately.
  }
}
