export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const FALLBACK = {
  402: 'You have reached your plan limit.',
  413: 'That file is too large.',
  429: 'Too many requests right now. Wait a moment and try again.',
  503: 'Reading took too long. Try again, or use a smaller photo.',
  504: 'Reading took too long. Try again, or use a smaller photo.',
};

export function createApi(cfg, auth) {
  async function request(method, path, body) {
    const token = await auth.accessToken();
    if (!token) {
      auth.signIn();
      throw new ApiError('Sign in to continue.', 401);
    }
    let res;
    try {
      res = await fetch(`${cfg.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError("Can't reach Inkwell. Check your connection and try again.");
    }
    if (res.status === 401) {
      auth.clear();
      auth.signIn();
      throw new ApiError('Your sign-in expired. Sign in again.', 401);
    }
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(data?.error || FALLBACK[res.status] || `Request failed (${res.status}). Try again.`, res.status);
    }
    return data;
  }

  return {
    /** Uploads a Blob straight to S3 with a presigned URL and returns its key. */
    async upload(blob) {
      const { key, url } = await request('POST', '/uploads', { contentType: blob.type, size: blob.size });
      let put;
      try {
        put = await fetch(url, { method: 'PUT', headers: { 'content-type': blob.type }, body: blob });
      } catch {
        throw new ApiError("Upload didn't finish. Check your connection and try again.");
      }
      if (!put.ok) throw new ApiError(`Upload failed (${put.status}). Try again.`, put.status);
      return key;
    },
    extract: (key) => request('POST', '/extract', { key }),
    translate: (text, target, noteId) => request('POST', '/translate', { text, target, noteId }),
    listNotes: () => request('GET', '/notes'),
    getNote: (id) => request('GET', `/notes/${encodeURIComponent(id)}`),
    updateNote: (id, patch) => request('PATCH', `/notes/${encodeURIComponent(id)}`, patch),
    deleteNote: (id) => request('DELETE', `/notes/${encodeURIComponent(id)}`),
    account: () => request('GET', '/account'),
    checkout: (plan) => request('POST', '/billing/checkout', { plan }),
    topup: (pages) => request('POST', '/billing/topup', { pages }),
    portal: () => request('POST', '/billing/portal'),
  };
}
