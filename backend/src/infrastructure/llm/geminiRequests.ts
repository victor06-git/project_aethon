import { setTimeout as sleep } from 'node:timers/promises';

const TRANSIENT = new Set([500, 502, 503, 504]);
const COOLDOWN_MS: Partial<Record<number, number>> = { 404: 300_000, 408: 15_000, 429: 60_000, 500: 15_000, 502: 15_000, 503: 15_000, 504: 15_000 };
const PROJECT_ERRORS = new Set([401, 402, 403]);

function statusOf(error: unknown, signal: AbortSignal): number | undefined {
  if (signal.aborted) return 408;
  if (!error || typeof error !== 'object' || !('status' in error)) return;
  if (typeof error.status === 'number') return error.status;
}

function failure(status?: number): Error {
  if (status === 408) return new Error('Gemini took too long to answer.');
  if (status === 429) return new Error('Gemini reached a rate or quota limit.');
  if (status === 402) return new Error('The Gemini project is out of prepaid credit.');
  if (status === 401 || status === 403) return new Error('The Gemini project rejected the request credentials.');
  if (status === 404) return new Error('The configured Gemini model is unavailable.');
  return new Error('Gemini could not answer.');
}

interface Options {
  model: string;
  fallbackModel?: string;
  timeoutMs: number;
  requestTimeoutMs?: number;
}

/** Limits retries and calls for one turn. Cooldowns are local to this warm adapter instance. */
export function createGeminiRequests({ model, fallbackModel, timeoutMs, requestTimeoutMs = timeoutMs }: Options) {
  const models = [...new Set([model, fallbackModel].filter((id): id is string => Boolean(id)))];
  const unavailable = new Map<string, { until: number; status: number }>();
  let projectBlocked: { until: number; status: number } | undefined;

  return {
    startTurn() {
      const deadline = Date.now() + timeoutMs;
      let activeModel: string | undefined;
      let retried = false;
      const timeLeft = () => deadline - Date.now();

      return async function request<T>(send: (modelId: string, signal: AbortSignal) => Promise<T>): Promise<T> {
        let lastError = failure();
        for (const modelId of activeModel ? [activeModel] : models) {
          if (projectBlocked && projectBlocked.until > Date.now()) throw failure(projectBlocked.status);
          const cooldown = unavailable.get(modelId);
          if (cooldown && cooldown.until > Date.now()) {
            lastError = failure(cooldown.status);
            continue;
          }

          for (;;) {
            const remainingMs = timeLeft();
            if (remainingMs <= 0) throw failure(408);
            const signal = AbortSignal.timeout(Math.min(requestTimeoutMs, remainingMs));
            try {
              const result = await send(modelId, signal);
              if (signal.aborted) throw failure(408);
              // A successful model turn can contain model-specific tool-call signatures.
              activeModel = modelId;
              return result;
            } catch (error) {
              const status = statusOf(error, signal);
              lastError = failure(status);
              if (status !== undefined && PROJECT_ERRORS.has(status)) {
                projectBlocked = { until: Date.now() + 60_000, status };
                throw lastError;
              }
              const transient = status !== undefined && TRANSIENT.has(status);
              if (transient && !retried && timeLeft() > 1_000) {
                retried = true;
                await sleep(300 + Math.floor(Math.random() * 200));
                continue;
              }
              if (status !== undefined) {
                const wait = COOLDOWN_MS[status];
                if (wait) unavailable.set(modelId, { until: Date.now() + wait, status });
              }
              if (!transient && status !== 429 && status !== 404 && status !== 408) throw lastError;
              break;
            }
          }
        }
        throw lastError;
      };
    }
  };
}
