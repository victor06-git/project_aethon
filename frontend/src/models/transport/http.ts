// Transport used when the app is served by the Node server or Vercel: plain fetch to /api.
// Every failure becomes an Error with a message a person can read, and the HTTP status.
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

export async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw failure('Could not reach the server. Check your connection and try again.', 0);
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* not JSON: a gateway or error page */ }
  if (!res.ok || json === null) throw failure(json?.message || `The server answered with an error (${res.status}).`, res.status);
  return json as T;
}
