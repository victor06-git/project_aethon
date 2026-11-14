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
// auto: Gemini when a key is present, otherwise rules only. "none" switches the model off.
const wanted = (env.REVI_LLM_PROVIDER || 'auto').toLowerCase();
const provider = wanted === 'auto' ? (apiKey ? 'gemini' : env.REVI_LLM_URL ? 'openai' : 'none') : wanted;
const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

export const config = {
  root: ROOT,
  port: Number(env.PORT) || 3000,
  data: {
    // auto: the S-Pankki CSV if the file exists, otherwise demo fixtures.
    source: (env.REVI_DATA_SOURCE || 'auto').toLowerCase(),
    file: resolve(env.REVI_DATASET || 'data/tx_junction_transactions.csv'),
    customerId: env.REVI_CUSTOMER_ID || 'CUST00001'
  },
  provider,
  gemini: {
    apiKey,
    model: env.REVI_LLM_MODEL || 'gemini-flash-latest',
    baseUrl: env.REVI_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
    timeoutMs: Number(env.REVI_LLM_TIMEOUT_MS) || 8000
  },
  // Kaiku: the full Python coach (web evidence via Exa + the user's data). When the URL is
  // set, letters and anything the local intents cannot answer go there.
  kaiku: {
    url: env.REVI_KAIKU_URL || '',
    timeoutMs: Number(env.REVI_KAIKU_TIMEOUT_MS) || 35000
  },
  openai: {
    url: env.REVI_LLM_URL || '',
    key: env.REVI_LLM_KEY || '',
    model: env.REVI_LLM_MODEL || 'gemma',
    timeoutMs: Number(env.REVI_LLM_TIMEOUT_MS) || 8000
  }
};

export type Config = typeof config;
