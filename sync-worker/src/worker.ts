/**
 * Danny Times family sync backend.
 *
 * One family, one JSON blob in KV. Devices authenticate with a shared family
 * code (the FAMILY_CODE worker secret) and use optimistic concurrency via
 * ETag/If-Match so a slow device can never silently clobber a faster one.
 */

export interface Env {
  SYNC_KV: KVNamespace;
  FAMILY_CODE?: string;
}

interface StoredBlob {
  version: number;
  updatedAt: number;
  data: unknown;
}

const KV_KEY = 'family-blob';
const MAX_BODY_BYTES = 1_000_000;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,If-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

async function codesMatch(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const bytesA = new Uint8Array(a);
  const bytesB = new Uint8Array(b);
  let diff = 0;
  for (let index = 0; index < bytesA.length; index += 1) diff |= bytesA[index] ^ bytesB[index];
  return diff === 0;
}

function parseIfMatch(header: string | null): number | null {
  if (header === null) return null;
  const value = Number(header.replaceAll('"', '').trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/v1/data') return json({ error: 'Not found.' }, 404);

    const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!env.FAMILY_CODE || bearer.length < 4 || !(await codesMatch(bearer, env.FAMILY_CODE))) {
      return json({ error: 'Wrong family code.' }, 401);
    }

    if (request.method === 'GET') {
      const stored = await env.SYNC_KV.get<StoredBlob>(KV_KEY, 'json');
      if (!stored) return json({ version: 0, updatedAt: null, data: null }, 200, { ETag: '"0"' });
      return json(stored, 200, { ETag: `"${stored.version}"` });
    }

    if (request.method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BODY_BYTES) return json({ error: 'Backup too large.' }, 413);
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        return json({ error: 'Body must be JSON.' }, 400);
      }

      const stored = await env.SYNC_KV.get<StoredBlob>(KV_KEY, 'json');
      const currentVersion = stored?.version ?? 0;
      const expected = parseIfMatch(request.headers.get('If-Match'));
      if (expected === null || expected !== currentVersion) {
        return json({ error: 'Version conflict.', version: currentVersion }, 412, { ETag: `"${currentVersion}"` });
      }

      const next: StoredBlob = { version: currentVersion + 1, updatedAt: Date.now(), data };
      await env.SYNC_KV.put(KV_KEY, JSON.stringify(next));
      return json({ version: next.version, updatedAt: next.updatedAt }, 200, { ETag: `"${next.version}"` });
    }

    if (request.method === 'DELETE') {
      await env.SYNC_KV.delete(KV_KEY);
      return json({ ok: true }, 200);
    }

    return json({ error: 'Method not allowed.' }, 405);
  },
};
