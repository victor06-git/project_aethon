// Node adapter: turns a node:http request into a router call and writes the JSON reply.
// Shared by the local server (server.ts) and the Vercel function (vercel.ts).
import type http from 'node:http';
import type { Container } from '../../container';

const MAX_BODY_BYTES = 200_000;   // a chat request carries the conversation and the trainer state
const NDJSON = 'application/x-ndjson';

type Log = (msg: string) => void;

export interface ApiOptions {
  /** Allow this origin to call the API from a browser. Leave empty when app and API share an origin. */
  corsOrigin?: string;
}

function corsHeaders(origin?: string): Record<string, string> {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

export async function handleApi(app: Container, req: http.IncomingMessage, res: http.ServerResponse, log: Log, options: ApiOptions = {}): Promise<void> {
  const cors = corsHeaders(options.corsOrigin);
  // Everything here is personal data: never cached.
  const json = (status: number, obj: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err: any) {
    return json(err?.status ?? 400, { message: err?.message ?? 'Bad request' });
  }
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { return json(400, { message: 'Bad JSON' }); }
  const query = Object.fromEntries(url.searchParams);
  // A client that sends Accept: application/x-ndjson gets progress events as they happen, then the result.
  if ((req.headers.accept ?? '').includes(NDJSON)) {
    res.writeHead(200, { 'Content-Type': `${NDJSON}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', ...cors });
    const send = (event: unknown) => { res.write(`${JSON.stringify(event)}\n`); };
    try {
      const result = await app.handle(req.method ?? 'GET', url.pathname, body, query, send);
      res.end(`${JSON.stringify({ type: 'done', result })}\n`);
    } catch (err: any) {
      if (!err?.status) log(err?.stack ?? String(err));
      res.end(`${JSON.stringify({ type: 'error', status: err?.status ?? 500, message: err?.status ? err.message : 'Internal error' })}\n`);
    }
    return;
  }
  try {
    json(200, await app.handle(req.method ?? 'GET', url.pathname, body, query));
  } catch (err: any) {
    if (!err?.status) log(err?.stack ?? String(err));
    json(err?.status ?? 500, { message: err?.status ? err.message : 'Internal error' });
  }
}
