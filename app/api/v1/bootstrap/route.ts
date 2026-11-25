import { errorResponse, requestIdFrom } from "../../../../lib/server/http.ts";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return errorResponse("UNSUPPORTED_RELEASE_CONTRACT", 410, requestIdFrom(request));
}
