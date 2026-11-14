// ResearchProvider adapter: Exa web search (POST /search). Returns the passages Exa found
// relevant, each with its source. The key goes in a header, never in the URL.
import type { Extraction, Source } from '../../domain/trainer';
import type { ResearchProvider } from '../../application/ports';
import type { Config } from '../../config';

const SNIPPET_CHARS = 600;
const EXTRACT_TIMEOUT_FACTOR = 2.5;   // a structured answer adds synthesis time on top of the search
const EXTRACT_INSTRUCTIONS = 'Use Finnish sources, including Finnish-language pages. Prefer original listings, provider terms, or official data. '
  + 'Use amounts in euros that the cited pages explicitly state. For offers, cite the individual listing and omit sold, expired or finance-only prices. '
  + 'Leave a field out when the sources do not state it clearly. Never estimate or calculate a figure yourself.';
const CONFIDENCE = ['low', 'medium', 'high'] as const;
function isHttp(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 500) return false;
  try {
    const parsed = new URL(url);
    return /^https?:\/\//i.test(url) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export interface ExaOptions { apiKey: string; baseUrl?: string; timeoutMs?: number; numResults?: number; fetchImpl?: typeof fetch }

interface ExaResult { title?: string; url?: string; publishedDate?: string; highlights?: string[]; text?: string }
interface ExaGrounding { field?: string; confidence?: string; citations?: { url?: string }[] }
interface ExaReply { results?: ExaResult[]; output?: { content?: unknown; grounding?: ExaGrounding[] } }

function toContent(content: unknown): Record<string, unknown> {
  let value = content;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toSource(r: ExaResult): Source {
  const passage = (r.highlights?.filter(Boolean).join(' … ') || r.text || '').replace(/\s+/g, ' ').trim();
  return { title: (r.title ?? '').slice(0, 700), url: r.url ?? '', published: (r.publishedDate ?? '').slice(0, 10), snippet: passage.slice(0, SNIPPET_CHARS) };
}

export function createExaResearch({ apiKey, baseUrl = 'https://api.exa.ai', timeoutMs = 8000, numResults = 4, fetchImpl = globalThis.fetch }: ExaOptions): ResearchProvider {
  // One Exa search. userLocation steers results towards Finnish sources and prices.
  async function post(query: string, extra: Record<string, unknown>, limitMs: number): Promise<ExaReply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    try {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/search`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ query, type: 'auto', numResults, userLocation: 'FI', contents: { highlights: { maxCharacters: SNIPPET_CHARS } }, ...extra })
      });
      if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);
      return await res.json() as ExaReply;
    } finally {
      clearTimeout(timer);
    }
  }
  const sourcesOf = (reply: ExaReply): Source[] => (reply.results ?? []).map(toSource).filter((s) => isHttp(s.url) && s.snippet);

  return {
    async search(query: string): Promise<Source[]> {
      return sourcesOf(await post(query, {}, timeoutMs));
    },

    // Exa answers in the requested shape and says which sources back each field (grounding).
    async extract(query: string, properties: Record<string, unknown>): Promise<Extraction> {
      const reply = await post(query, {
        contents: { highlights: { maxCharacters: SNIPPET_CHARS }, maxAgeHours: 0, livecrawlTimeout: timeoutMs },
        outputSchema: { type: 'object', properties }, systemPrompt: EXTRACT_INSTRUCTIONS
      }, timeoutMs * EXTRACT_TIMEOUT_FACTOR);
      return {
        content: toContent(reply.output?.content),
        grounding: (reply.output?.grounding ?? []).map((g) => ({
          field: String(g.field ?? ''),
          confidence: CONFIDENCE.find((c) => c === g.confidence) ?? 'low',
          urls: (g.citations ?? []).map((c) => c.url).filter(isHttp)
        })),
        sources: sourcesOf(reply)
      };
    }
  };
}

/** Null when no key is configured: the trainer then says research is off and keeps its assumptions. */
export function createResearch(config: Config): ResearchProvider | null {
  return config.exa.apiKey ? createExaResearch({ apiKey: config.exa.apiKey, baseUrl: config.exa.baseUrl, timeoutMs: config.exa.timeoutMs }) : null;
}
