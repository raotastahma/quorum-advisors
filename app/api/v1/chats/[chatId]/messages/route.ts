import { errorResponse, requestIdFrom } from "../../../../../../lib/server/http.ts";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = {
  params: Promise<{ chatId: string }> | { chatId: string };
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  await context.params;

  return errorResponse("UNSUPPORTED_RELEASE_CONTRACT", 410, requestIdFrom(request));
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  await context.params;

  return errorResponse("UNSUPPORTED_RELEASE_CONTRACT", 410, requestIdFrom(request));
}
