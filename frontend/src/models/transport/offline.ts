// Transport used by the standalone HTML file: the same backend core runs in the browser
// (demo fixtures, rules classifier; no model or CSV in the browser).
import { createContainer } from '../../../../backend/src/container';

const core = createContainer();

export async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const [pathname, qs] = path.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs ?? ''));
  try {
    return await core.handle(method, pathname, body, query);
  } catch (err: any) {
    throw Object.assign(new Error(err?.message ?? 'Request failed'), { status: err?.status ?? 500 });
  }
}
