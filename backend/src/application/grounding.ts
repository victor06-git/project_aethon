// Grounding check for model text: every euro amount and percentage the model writes must
// appear in the evidence (tool results and the conversation). The model explains; it never
// introduces a figure of its own.

const NUMBER = String.raw`\d{1,3}(?:[  \u202f,.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?`;
const NUMBERS = new RegExp(NUMBER, 'g');
const FIGURES = new RegExp(String.raw`€\s?(${NUMBER})|(${NUMBER})\s?(?:€|%|euros?\b|eur\b)`, 'gi');
const EPSILON = 1e-9;

/** "1,117" → 1117, "12 500" → 12500, "12.500" → 12500, "170,8" → 170.8. */
export function toNumber(token: string): number {
  const compact = token.replace(/[  \u202f]/g, '');
  const grouped = compact.match(/^(\d{1,3}(?:[,.]\d{3})+)(?:[.,](\d{1,2}))?$/);
  if (grouped) return Number(`${grouped[1].replace(/[,.]/g, '')}.${grouped[2] ?? '0'}`);
  return Number(compact.replace(',', '.'));
}

export const numbersIn = (text: string): number[] => (text.match(NUMBERS) ?? []).map(toNumber).filter(Number.isFinite);

/** Find a quoted amount with its currency or percentage sign, rather than a matching date or model number. */
export function mentionsFigure(text: string, value: number, unit: 'eur' | 'percent'): boolean {
  const pattern = unit === 'eur'
    ? new RegExp(String.raw`(?:€|\bEUR\b)\s*(${NUMBER})|(${NUMBER})\s*(?:€|euros?\b|eur\b)`, 'gi')
    : new RegExp(String.raw`(${NUMBER})\s*(?:%|per cent\b|percent\b)`, 'gi');
  return [...text.matchAll(pattern)].some((m) => Math.abs(toNumber(m[1] ?? m[2]) - value) < 0.005);
}

const decimalsOf = (n: number): number => (String(n).split('.')[1] ?? '').length;
const roundTo = (n: number, decimals: number): number => Math.round(n * 10 ** decimals) / 10 ** decimals;

/** Every number in a JSON-like value: numeric fields as they are, plus the numbers written inside strings. */
export function collectNumbers(value: unknown): number[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [Math.abs(value)] : [];
  if (typeof value === 'string') return numbersIn(value);
  if (Array.isArray(value)) return value.flatMap(collectNumbers);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectNumbers);
  return [];
}

/** The figures in `text` that the evidence does not contain (rounding to the written precision is allowed). */
export function ungroundedFigures(text: string, evidence: unknown): string[] {
  const known = collectNumbers(evidence);
  const missing: string[] = [];
  for (const match of text.matchAll(FIGURES)) {
    const value = toNumber(match[1] ?? match[2]);
    const decimals = decimalsOf(value);
    if (!known.some((k) => Math.abs(roundTo(k, decimals) - value) < EPSILON)) missing.push(match[0].trim());
  }
  return missing;
}
