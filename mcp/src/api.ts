/** Thin client for the public TronEnergyFrog HTTP API. */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ApiSettings = {
  /** Customer API origin, e.g. https://api.tronenergyfrog.com */
  apiBase: string;
  /** Website origin that serves the public price snapshot. */
  siteBase: string;
  /** Optional account API key from @tron_energy_frog_bot. */
  apiKey?: string;
  timeoutMs: number;
  fetch: FetchLike;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function assertTronAddress(value: string, field = "address"): void {
  if (!TRON_ADDRESS.test(value)) {
    throw new ApiError(400, "INVALID_TRON_ADDRESS", `${field} must be a TRON Base58 address starting with T.`);
  }
}

async function readError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`;
  let message = response.statusText || "Request failed";
  try {
    const body = (await response.json()) as { code?: unknown; title?: unknown; message?: unknown; error?: unknown };
    if (typeof body.code === "string") code = body.code;
    const text = [body.title, body.message, body.error].find((value) => typeof value === "string");
    if (typeof text === "string") message = text;
  } catch {
    // Non-JSON error bodies keep the HTTP status text.
  }
  return new ApiError(response.status, code, message);
}

export async function requestJson<T>(
  settings: ApiSettings,
  url: string,
  init: RequestInit & { authenticated?: boolean } = {},
  fetcher: FetchLike = settings.fetch,
): Promise<{ body: T; response: Response }> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (init.authenticated) {
    if (!settings.apiKey) {
      throw new ApiError(401, "API_KEY_REQUIRED", "Set TRONENERGYFROG_API_KEY to use account tools.");
    }
    headers.set("Authorization", `Bearer ${settings.apiKey}`);
  }
  const response = await fetcher(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(settings.timeoutMs),
  });
  if (!response.ok) throw await readError(response);
  return { body: (await response.json()) as T, response };
}

export function apiUrl(settings: ApiSettings, path: string): string {
  return new URL(path, settings.apiBase).toString();
}
