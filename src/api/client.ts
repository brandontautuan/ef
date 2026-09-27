// Same-origin JSON API helper for the shared features (session, scans,
// leaderboard, social). The session cookie is HttpOnly: this code never reads
// or stores the credential; the browser attaches it to same-origin requests.

export const API_BASE = (import.meta.env.VITE_MOG_API_BASE ?? '').replace(/\/+$/, '');
export const apiEnabled = API_BASE !== '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterS?: number,
    readonly requestId?: string,
  ) {
    super(message);
  }

  /** Network failures and temporary unavailability; never auth, conflicts, or bad input. */
  get transient() {
    return this.status === 0 || this.status === 503;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  form?: FormData;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Bounded retries for transient failures. Only safe for reads or intent-preserving writes. */
  retries?: number;
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function once<T>(path: string, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.form) body = options.form;
  else if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(options.body); }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { method: options.method ?? 'GET', headers, body, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
  } catch {
    if (options.signal?.aborted) throw new ApiError(0, 'aborted', 'Request cancelled.');
    throw new ApiError(0, 'network', 'Network problem. Check your connection and try again.');
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
  if (response.status === 204) return undefined as T;
  let payload: any = null;
  try { payload = await response.json(); } catch { /* non-JSON error page from a proxy */ }
  if (!response.ok) {
    const error = payload?.error;
    const retryAfter = Number(response.headers.get('Retry-After'));
    throw new ApiError(
      response.status,
      typeof error?.code === 'string' ? error.code : response.status === 503 ? 'unavailable' : 'http_error',
      typeof error?.message === 'string' ? error.message : 'Something went wrong. Please try again.',
      error?.details && typeof error.details === 'object' ? error.details : undefined,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      typeof payload?.request_id === 'string' ? payload.request_id : undefined,
    );
  }
  return payload as T;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const retries = Math.min(options.retries ?? 0, 3);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once<T>(path, options);
    } catch (error) {
      if (!(error instanceof ApiError) || !error.transient || error.code === 'aborted' || attempt >= retries) throw error;
      await sleep(400 * 2 ** attempt + Math.random() * 200);
    }
  }
}

export function newIdempotencyKey() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
