// Vercel entry for the "api" service (vercel.json), public at /api/*. The service receives
// the original path (/api/...), which is what the router matches. Settings: Vercel env vars.
// Full CSV stays local. An access-controlled demo can opt into one synthetic customer.
import type http from 'node:http';
import { config } from '../../config';
import { createContainer, type Container } from '../../container';
import { createLlm } from '../../infrastructure/llm';
import { createAgent } from '../../infrastructure/llm/geminiAgent';
import { createResearch } from '../../infrastructure/research/exaResearch';
import { loadEncodedCsvTransactions } from '../../infrastructure/repositories/csvTransactions';
import { handleApi } from './nodeAdapter';

const log = (msg: string) => console.warn(`[revi] ${msg}`);

let app: Promise<Container> | null = null;

// One container per warm function instance. It holds no user state: the client sends it.
function getApp(): Promise<Container> {
  app ??= (async () => {
    const { source, encoded, customerId } = config.data;
    if (source === 'csv' && !encoded) throw new Error('The deployed CSV demo requires REVI_DATASET_GZIP_BASE64');
    const transactions = source !== 'fixture' && encoded ? await loadEncodedCsvTransactions({ encoded, customerId }) : null;
    return createContainer({ transactions, model: createLlm(config), agent: createAgent(config), research: createResearch(config), log });
  })();
  return app;
}

export default async function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let container: Container;
  try {
    container = await getApp();
  } catch {
    log('Unable to load the configured demo dataset');
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ message: 'The configured demo dataset could not be loaded.' }));
    return;
  }
  return handleApi(container, req, res, log, { corsOrigin: config.corsOrigin });
}
