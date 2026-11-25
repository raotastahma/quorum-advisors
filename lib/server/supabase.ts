import type { ServerConfig } from "./config.ts";

type PostgrestRequest = {
  method?: "GET" | "PATCH" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  prefer?: string;
};

export class UpstreamUnavailableError extends Error {
  constructor(message = "Supabase request failed.") {
    super(message);
    this.name = "UpstreamUnavailableError";
  }
}

export async function postgrest<T>(
  config: ServerConfig,
  request: PostgrestRequest
): Promise<T> {
  const url = new URL(`/rest/v1/${request.path}`, config.supabaseUrl);

  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers = new Headers({
    apikey: config.supabaseSecretKey
  });

  if (request.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (request.prefer) {
    headers.set("prefer", request.prefer);
  }

  let response: Response;

  try {
    response = await fetch(url, {
      method: request.method ?? "GET",
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body)
    });
  } catch (error) {
    throw new UpstreamUnavailableError(error instanceof Error ? error.message : undefined);
  }

  if (!response.ok) {
    throw new UpstreamUnavailableError(await response.text());
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const responseText = await response.text();

  if (responseText.length === 0) {
    return undefined as T;
  }

  return JSON.parse(responseText) as T;
}
