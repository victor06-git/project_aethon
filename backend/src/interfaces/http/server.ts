// Node HTTP server: JSON API + the React app (served through Vite in middleware mode).
// Run: npm start   (settings: .env, see .env.example)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createVite } from 'vite';
import { config } from '../../config';
import { createContainer } from '../../container';
import { createLlm } from '../../infrastructure/llm';
import { createAgent } from '../../infrastructure/llm/geminiAgent';
import { createResearch } from '../../infrastructure/research/exaResearch';
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
  const agent = createAgent(config);
  const research = createResearch(config);
  const app = createContainer({ transactions, model, agent, research, log });
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
    void handleApi(app, req, res, log, { corsOrigin: config.corsOrigin });
  });
  server.listen(config.port, () => {
    console.log(`Revi preview: http://localhost:${config.port}`);
    const modelName = config.provider === 'claude' ? config.claude.model
      : config.provider === 'chatgpt' ? config.chatgpt.model
      : config.provider === 'gemini' ? config.gemini.model
      : '';
    console.log(agent ? `Trainer: ${agent.name} ${modelName} with tools (rules as fallback)` : 'Trainer: rules only (set ANTHROPIC_API_KEY or OPENAI_API_KEY)');
    console.log(research ? 'Web research: Exa' : 'Web research: off (set EXA_API_KEY)');
    console.log(model ? `Coach model: ${config.provider} ${modelName} (rules as fallback)` : 'Coach model: off, rules only');
  });
}

main().catch((err) => { console.error(err.message); process.exit(1); });
