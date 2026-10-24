export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Machine-readable code from the API (e.g. "plan_recipient_limit"), if any. */
    readonly code: string | null,
    message: string,
    /** Other fields of the error body, e.g. { limit, used, requiredPlan } on plan-limit errors. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** fetch with a fresh App Bridge ID token. Never stores the token. Throws ApiError on non-2xx. */
async function authorizedFetch(
  path: string,
  init: RequestInit = {},
  accept = 'application/json',
): Promise<Response> {
  const token = await shopify.idToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', accept);
  if (init.body !== undefined && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let code: string | null = null;
    let details: Record<string, unknown> = {};
    try {
      const body = (await res.json()) as Record<string, unknown>;
      code = typeof body['error'] === 'string' ? body['error'] : null;
      details = body;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(
      res.status,
      code,
      `${init.method ?? 'GET'} ${path} failed with ${res.status}`,
      details,
    );
  }
  return res;
}

/** Calls the AgeShield API and parses the JSON response. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authorizedFetch(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Downloads a file from the API and saves it under the server-provided filename (no pop-up windows). */
export async function download(path: string): Promise<void> {
  const res = await authorizedFetch(path, {}, '*/*');
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download';
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
