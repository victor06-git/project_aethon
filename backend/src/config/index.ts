// Settings from environment variables. A .env file in the project root is read if present;
// variables already set in the environment win. .env is git-ignored: never commit keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));
const env = process.env;
const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
const openaiKey = env.OPENAI_API_KEY || '';
const anthropicKey = env.ANTHROPIC_API_KEY || '';
// auto: Claude when ANTHROPIC_API_KEY is set, else ChatGPT, else Gemini, otherwise rules only.
// "none" switches the model off.
const wanted = (env.REVI_LLM_PROVIDER || 'auto').toLowerCase();
const provider = wanted === 'auto'
  ? (anthropicKey ? 'claude' : openaiKey ? 'chatgpt' : apiKey ? 'gemini' : env.REVI_LLM_URL ? 'openai' : 'none')
  : wanted;
const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const timeout = (value: string | undefined, fallback: number) => {
  const ms = Number(value);
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 300_000 ? ms : fallback;
};

export const config = {
  root: ROOT,
  port: Number(env.PORT) || 3000,
  data: {
    // auto: the S-Pankki CSV if the file exists, otherwise demo fixtures.
    source: (env.REVI_DATA_SOURCE || 'auto').toLowerCase(),
    file: resolve(env.REVI_DATASET || 'data/tx_junction_transactions.csv'),
    customerId: env.REVI_CUSTOMER_ID || 'CUST00001',
    encoded: env.REVI_DATASET_GZIP_BASE64 || ''
  },
  provider,
  gemini: {
    apiKey,
    model: env.REVI_LLM_MODEL || 'gemini-3.8-flash',
    fallbackModel: env.REVI_LLM_FALLBACK_MODEL?.trim() ?? 'gemini-3.5-flash-lite',
    baseUrl: env.REVI_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
    timeoutMs: timeout(env.REVI_LLM_TIMEOUT_MS, 8000),
    // The whole trainer turn shares this deadline, including waits and follow-up model calls.
    agentTimeoutMs: timeout(env.REVI_AGENT_TIMEOUT_MS, 20000)
  },
  // ChatGPT (OpenAI API): the trainer agent (function calling) and the question classifier.
  chatgpt: {
    apiKey: openaiKey,
    model: env.OPENAI_MODEL || 'gpt-4.1-mini',
    baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    timeoutMs: timeout(env.OPENAI_TIMEOUT_MS, 15000),
    agentTimeoutMs: timeout(env.REVI_AGENT_TIMEOUT_MS, 20000)
  },
  // Claude (Anthropic API): trainer agent with tool use.
  claude: {
    apiKey: anthropicKey,
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    timeoutMs: timeout(env.ANTHROPIC_TIMEOUT_MS, 20000),
    agentTimeoutMs: timeout(env.REVI_AGENT_TIMEOUT_MS, 45000)
  },
  // Exa web search: live prices and benchmarks for the trainer. Off without a key.
  exa: { apiKey: env.EXA_API_KEY || '', baseUrl: env.REVI_EXA_BASE_URL || 'https://api.exa.ai', timeoutMs: Number(env.REVI_EXA_TIMEOUT_MS) || 8000 },
  // Only needed when the frontend is served from another origin than the API.
  corsOrigin: env.REVI_CORS_ORIGIN || '',
  openai: {
    url: env.REVI_LLM_URL || '',
    key: env.REVI_LLM_KEY || '',
    model: env.REVI_LLM_MODEL || 'gemma',
    timeoutMs: Number(env.REVI_LLM_TIMEOUT_MS) || 8000
  }
};

export type Config = typeof config;
