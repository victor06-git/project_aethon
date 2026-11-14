// Tests the configured model with one question. Prints the route, never the key.
// Run: npm run check:llm  [-- "your question"]
import { config } from '../backend/src/config';
import { createLlm } from '../backend/src/infrastructure/llm';

const llm = createLlm(config);
if (!llm) {
  console.log('Model is off (no GEMINI_API_KEY in .env, or KAIKU_LLM_PROVIDER=none). The app uses the rules.');
} else {
  const q = process.argv.slice(2).join(' ') || 'What happens if I stop ordering food delivery?';
  console.log(`Provider: ${config.provider}${config.provider === 'gemini' ? `, model ${config.gemini.model}` : ''}`);
  console.log(`Question: ${q}`);
  const t0 = Date.now();
  try {
    console.log('Route:', await llm.classify(q), `(${Date.now() - t0} ms)`);
  } catch (err) {
    console.error(`Model call failed: ${(err as Error).message}. The app would fall back to the rules.`);
    process.exitCode = 1;
  }
}
