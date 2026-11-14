// Picks the model adapter from config. Returns null when no model is configured (rules only).
import { createGeminiClassifier } from './geminiClassifier';
import { createHttpClassifier } from './httpClassifier';
import type { Config } from '../../config';
import type { QuestionClassifier } from '../../application/ports';

export function createLlm(config: Config): QuestionClassifier | null {
  if (config.provider === 'gemini' && config.gemini.apiKey) return createGeminiClassifier(config.gemini);
  if (config.provider === 'openai' && config.openai.url) return createHttpClassifier(config.openai);
  return null;
}
