// Vercel serverless entry for /api/*. Bundled by tools/build-vercel.ts into
// .vercel/output/functions/api.func/index.mjs. Settings come from the Vercel env vars.
// The S-Pankki CSV is git-ignored, so deployments always serve the demo fixtures.
import type http from 'node:http';
import { config } from '../../config';
import { createContainer, type Container } from '../../container';
import { createLlm } from '../../infrastructure/llm';
import { handleApi } from './nodeAdapter';

const log = (msg: string) => console.warn(`[revi] ${msg}`);

let app: Container | null = null;

// One container per warm function instance.
function getApp(): Container {
  app ??= createContainer({ transactions: null, model: createLlm(config), log });
  return app;
}

export default function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  return handleApi(getApp(), req, res, log);
}
