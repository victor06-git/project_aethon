// Transport used when the app is served by the Node server or Vercel: plain fetch to /api.
// Every failure becomes an Error with a message a person can read, and the HTTP status.
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

export type StepEvent = { type: 'step'; step: unknown };

/** Like `request`, but the server reports each step as it happens (newline-delimited JSON), then the result. */
export async function requestStream<T = any>(method: string, path: string, body: unknown, onStep: (event: StepEvent) => void): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
  } catch {
    throw failure('Could not reach the server. Check your connection and try again.', 0);
  }
  if (!res.ok || !res.body) {
    let json: any = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    throw failure(json?.message || `The server answered with an error (${res.status}).`, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: T | undefined;
  let finished = false;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'step') onStep(event);
    else if (event.type === 'done') { result = event.result as T; finished = true; }
    else if (event.type === 'error') throw failure(event.message || 'Request failed', event.status ?? 500);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(handle);
  }
  handle(buffer);
  if (!finished) throw failure('The connection closed before the answer arrived. Try again.', 0);
  return result as T;
}

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
