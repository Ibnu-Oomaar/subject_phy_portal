
/**
 * Single place that talks to the backend. Requests use relative URLs (Vite proxies /api in development, a reverse
 * proxy does in production), send the HttpOnly session cookie automatically, and add the CSRF token to every
 * state-changing request. All failures surface as ApiError with the backend's error code.
 */

const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
  /** Field messages from a VALIDATION_ERROR: path "entries.0.textbook" -> message. */
  get fieldErrors(): Array<{ path: string; message: string }> {
    return this.code === 'VALIDATION_ERROR' && Array.isArray(this.details) ? (this.details as Array<{ path: string; message: string }>) : [];
  }
}

let csrfToken = '';
let onUnauthenticated: (() => void) | null = null;

export const setCsrfToken = (token: string): void => {
  csrfToken = token;
};
/** Called when any request (other than a login attempt) comes back 401, so the app can return to the login page. */
export const setUnauthenticatedHandler = (handler: (() => void) | null): void => {
  onUnauthenticated = handler;
};

type Query = Record<string, string | number | boolean | undefined | null>;

export function withQuery(path: string, query?: Query): string {
  const params = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return `${API_BASE_URL}/api${path}${qs ? `?${qs}` : ''}`;
}

async function toError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody = { code: 'HTTP_ERROR', message: `The server answered with status ${res.status}.` };
  try {
    const json = (await res.json()) as { error?: ApiErrorBody };
    if (json.error?.message) body = json.error;
  } catch {
    // not JSON (for example a proxy error page): keep the generic message
  }
  if (res.status === 413) body = { code: 'PAYLOAD_TOO_LARGE', message: body.message };
  return new ApiError(res.status, body);
}

async function send(method: string, path: string, opts: { query?: Query; body?: unknown; form?: FormData; auth?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form; // the browser sets the multipart boundary itself
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(withQuery(path, opts.query), { method, headers, body, credentials: 'include' });
  } catch {
    throw new ApiError(0, { code: 'NETWORK', message: 'Cannot reach the server. Check your connection and try again.' });
  }
  if (!res.ok) {
    const err = await toError(res);
    if (res.status === 401 && opts.auth !== false && err.code === 'UNAUTHENTICATED') onUnauthenticated?.();
    throw err;
  }
  return res;
}

async function json<T>(method: string, path: string, opts: Parameters<typeof send>[2] = {}): Promise<T> {
  const res = await send(method, path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => json<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown, opts?: { auth?: boolean }) => json<T>('POST', path, { body: body ?? {}, auth: opts?.auth }),
  put: <T>(path: string, body?: unknown) => json<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => json<T>('PATCH', path, { body: body ?? {} }),
  del: <T>(path: string) => json<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => json<T>('POST', path, { form }),

  /** Fetches a file and hands it to the browser as a download. */
  async download(path: string, query?: Query): Promise<string> {
    const res = await send('GET', path, { query });
    const disposition = res.headers.get('content-disposition') ?? '';
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'export.xlsx';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  },
};

/** Best human message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
