// Node adapter: turns a node:http request into a router call and writes the JSON reply.
// Shared by the local server (server.ts) and the Vercel function (vercel.ts).
import type http from 'node:http';
import type { Container } from '../../container';

const MAX_BODY_BYTES = 100_000;

type Log = (msg: string) => void;

const json = (res: http.ServerResponse, status: number, obj: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

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

export async function handleApi(app: Container, req: http.IncomingMessage, res: http.ServerResponse, log: Log): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err: any) {
    return json(res, err?.status ?? 400, { message: err?.message ?? 'Bad request' });
  }
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { return json(res, 400, { message: 'Bad JSON' }); }
  try {
    json(res, 200, await app.handle(req.method ?? 'GET', url.pathname, body, Object.fromEntries(url.searchParams)));
  } catch (err: any) {
    if (!err?.status) log(err?.stack ?? String(err));
    json(res, err?.status ?? 500, { message: err?.status ? err.message : 'Internal error' });
  }
}
