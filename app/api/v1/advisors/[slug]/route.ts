import { errorResponse, requestIdFrom } from "../../../../../lib/server/http.ts";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ slug: string }> | { slug: string };
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  await context.params;

  return errorResponse("UNSUPPORTED_RELEASE_CONTRACT", 410, requestIdFrom(request));
}
