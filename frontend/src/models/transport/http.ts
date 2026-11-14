// Transport used when the app is served by the Node server: plain fetch to /api.
export async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.message || 'Request failed'), { status: res.status });
  return json as T;
}
