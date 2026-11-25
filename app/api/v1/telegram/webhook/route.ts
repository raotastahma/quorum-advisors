import { handleTelegramWebhook } from "../../../../../lib/server/telegram/webhook.ts";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  return handleTelegramWebhook(request);
}
