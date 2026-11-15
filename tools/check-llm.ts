// Run: npm run check:llm [-- "question that needs a trainer tool"]
import { config } from '../backend/src/config';
import { createContainer } from '../backend/src/container';
import { createLlm } from '../backend/src/infrastructure/llm';
import { createAgent } from '../backend/src/infrastructure/llm/geminiAgent';

const question = process.argv.slice(2).join(' ').trim();

async function checkClassifier(started: number) {
  const classifier = createLlm(config);
  if (!classifier) throw new Error('Set REVI_LLM_URL to check the OpenAI-compatible classifier.');
  try {
    await classifier.classify(question || 'What happens if I stop ordering food delivery?');
    console.log(`OpenAI-compatible classifier responded (${Date.now() - started} ms).`);
  } catch {
    throw new Error('OpenAI-compatible classifier check failed. Check its endpoint and credentials.');
  }
}

async function checkTrainer(started: number) {
  const wanted = process.env.REVI_LLM_PROVIDER?.toLowerCase();
  if (config.provider !== 'gemini' && config.provider !== 'chatgpt' && wanted && wanted !== 'auto') {
    throw new Error('The trainer model is disabled. Use REVI_LLM_PROVIDER=chatgpt, gemini or auto to check it.');
  }
  const chatgpt = config.provider === 'chatgpt';
  const who = chatgpt ? `ChatGPT ${config.chatgpt.model}` : `Gemini ${config.gemini.model}`;
  if (chatgpt ? !config.chatgpt.apiKey.trim() : !config.gemini.apiKey.trim()) {
    throw new Error('Set OPENAI_API_KEY (ChatGPT) or GEMINI_API_KEY (Gemini) to check the trainer.');
  }

  let answer;
  try {
    const app = createContainer({ agent: createAgent({ ...config, gemini: { ...config.gemini, fallbackModel: '' } }) });
    ({ answer } = await app.trainer.chat({ messages: [{ role: 'user', text: question || 'What can I safely spend this week?' }] }));
  } catch {
    throw new Error(`${who} trainer check failed. Check the configured model, credentials, and quota.`);
  }
  const trace = answer.trace ?? [];
  const failed = trace.find((step) => step.kind === 'model' && step.status === 'failed');
  if (failed) {
    throw new Error(`${who} did not complete and the trainer used its built-in rules (${failed.detail ?? 'no detail'}). Check model access and quota.`);
  }
  if (answer.source !== 'model' || trace.some((step) => step.kind === 'rules')) {
    throw new Error('The trainer returned a rules-based answer. Ask a question that requires a tool, such as the default safe-to-spend question.');
  }
  if (!trace.some((step) => step.kind === 'model' && step.status === 'done') ||
      !trace.some((step) => step.kind === 'tool' && step.status === 'done')) {
    throw new Error(`${who} responded without completing a trainer tool. Use the default safe-to-spend question to verify tool calling.`);
  }
  console.log(`${who} completed the trainer tool and answer on demo data (${Date.now() - started} ms).`);
}

try {
  const started = Date.now();
  if (config.provider === 'openai') await checkClassifier(started);
  else await checkTrainer(started);
} catch (err) {
  console.error(err instanceof Error ? err.message : 'Model check failed.');
  process.exitCode = 1;
}
