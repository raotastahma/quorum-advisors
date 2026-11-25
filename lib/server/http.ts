export const JSON_HEADERS = {
  "content-type": "application/json"
};

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNSUPPORTED_RELEASE_CONTRACT"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE";

const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  UNAUTHORIZED: "Telegram session is invalid or expired.",
  FORBIDDEN: "The requested action is not allowed.",
  NOT_FOUND: "The requested resource was not found.",
  CONFLICT: "The requested action conflicts with current state.",
  UNSUPPORTED_RELEASE_CONTRACT:
    "This Mini App/browser HTTP endpoint is unsupported in the Telegram bot-only release.",
  VALIDATION_ERROR: "The request is invalid.",
  RATE_LIMITED: "Too many requests.",
  UPSTREAM_UNAVAILABLE: "Persistence is temporarily unavailable."
};

export function requestIdFrom(request: Request): string {
  return request.headers.get("x-request-id") ?? crypto.randomUUID();
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit & { requestId: string }
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", JSON_HEADERS["content-type"]);
  headers.set("x-request-id", init.requestId);

  return Response.json(body, {
    ...init,
    headers
  });
}

export function errorResponse(
  code: ApiErrorCode,
  status: number,
  requestId: string
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: ERROR_MESSAGES[code],
        requestId
      }
    },
    { status, requestId }
  );
}
