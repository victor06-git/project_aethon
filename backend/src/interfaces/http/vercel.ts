// Vercel entry for the "api" service (vercel.json), public at /api/*. The service receives
// the original path (/api/...), which is what the router matches. Settings: Vercel env vars.
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
