// Node HTTP server: JSON API + the React app (served through Vite in middleware mode).
// Run: npm start   (settings: .env, see .env.example)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createVite } from 'vite';
import { config } from '../../config';
import { createContainer } from '../../container';
import { createLlm } from '../../infrastructure/llm';
import { loadCsvTransactions } from '../../infrastructure/repositories/csvTransactions';
import { handleApi } from './nodeAdapter';

const log = (msg: string) => console.warn(`[revi] ${msg}`);

async function loadTransactions() {
  const { source, file, customerId } = config.data;
  if (source === 'fixture') return null;
  if (source === 'auto' && !fs.existsSync(file)) {
    log(`dataset not found (${path.relative(config.root, file)}), using demo fixtures`);
    return null;
  }
  const t0 = Date.now();
  const repo = await loadCsvTransactions({ file, customerId });
  console.log(`Data: S-Pankki dataset, ${customerId}, ${repo.list().length} transactions up to ${repo.asOf()} (${Date.now() - t0} ms)`);
  return repo;
}

async function main() {
  const transactions = await loadTransactions();
  const model = createLlm(config);
  const app = createContainer({ transactions, model, log });
  const server = http.createServer();
  // Vite serves the React app and live-reloads it over the same port (hot module replacement).
  const vite = await createVite({
    configFile: path.join(config.root, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa'
  });

  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (!url.pathname.startsWith('/api/')) return vite.middlewares(req, res);
    void handleApi(app, req, res, log);
  });
  server.listen(config.port, () => {
    console.log(`Revi preview: http://localhost:${config.port}`);
    console.log(model ? `Coach model: ${config.provider} ${config.provider === 'gemini' ? config.gemini.model : ''} (rules as fallback)` : 'Coach model: off, rules only');
  });
}

main().catch((err) => { console.error(err.message); process.exit(1); });
