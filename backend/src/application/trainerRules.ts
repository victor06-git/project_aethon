// Fallback when Gemini is off or fails: keyword rules pick the same tool call the model
// would. Deterministic and offline, so the app (and the standalone build) always answers.
import { toNumber } from './grounding';
import type { QuestionClassifier, ToolCall } from './ports';
import type { CashLine, GoalDraft } from '../domain/trainer';
import type { Period } from '../domain/spending';

export interface RuleContext { lines: CashLine[]; goal: GoalDraft | null; hasPlan: boolean; pendingBrief: boolean; year: string }

const MONEY = /€\s?(\d[\d ,.]*\d|\d)\s?(k\b)?|(\d[\d ,.]*\d|\d)\s?(k\b)?\s?(?:€|euros?\b|eur\b)|\b(\d+(?:[.,]\d+)?)\s?k\b/i;
const AMOUNT_TOLERANCE = 0.5;
const MIN_LABEL_WORD = 4;

/** The first euro amount in the text: "€120", "200 euros", "12k". */
function money(text: string): number | undefined {
  const m = text.match(MONEY);
  if (!m) return undefined;
  const value = toNumber((m[1] ?? m[3] ?? m[5]).trim());
  return m[2] || m[4] || m[5] ? value * 1000 : value;
}

const firstNumber = (m: RegExpMatchArray | null, index = 1): number | undefined => (m ? toNumber(m[index]) : undefined);

// ---- Corrections: "that €120 transfer was a one-off gift, not a monthly bill" ----

function targetBasket(q: string): string | undefined {
  const positive = q.replace(/\bnot\b[^,.;!?]*/g, ' ');           // what it IS, without the "not ..." part
  if (/one[- ]?off|once only|\bgift\b|won'?t (happen|repeat)|single payment/.test(positive)) return 'one_off';
  if (/irregular|repair|maintenance|insurance|medical|doctor|dentist|annual|yearly|once a year|now and then/.test(positive)) return 'irregular';
  if (/every month|each month|monthly|\bregular\b|recurring|subscription/.test(positive)) return 'regular';
  if (/everyday|discretionary|optional|impulse|\btreat\b|for fun/.test(positive)) return 'everyday';
  if (/\bnot\b (a |an |my )?(monthly|regular|recurring)/.test(q)) return 'one_off';
  return undefined;
}

function targetLine(q: string, lines: CashLine[]): CashLine | undefined {
  const named = lines.filter((l) => l.label.toLowerCase().split(/[^a-zäöå0-9]+/).some((w) => w.length >= MIN_LABEL_WORD && q.includes(w)));
  const amount = money(q);
  const priced = amount === undefined ? [] : lines.filter((l) => Math.abs(l.lastAmount - amount) < AMOUNT_TOLERANCE);
  return priced.find((l) => named.includes(l)) ?? (priced.length === 1 ? priced[0] : undefined) ?? (named.length === 1 ? named[0] : undefined);
}

// ---- Goals and what-ifs ----

const CUT_WORDS: [string, RegExp][] = [
  ['dining', /dining|eating out|restaurant|take-?away|delivery|lunch|coffee/],
  ['groceries', /grocer|food shopping/],
  ['taxi', /taxi|\bcab\b/],
  ['leisure', /leisure|cinema|entertainment|going out/],
  ['transport', /transport|fuel/],
  ['shopping', /shopping|clothes/]
];

function monthsIn(q: string): number | undefined {
  const m = q.match(/\b(?:in|within|over) (\d+|a|one|two|three) (months?|years?)\b/);
  if (m) {
    const n = { a: 1, one: 1, two: 2, three: 3 }[m[1]] ?? Number(m[1]);
    return m[2].startsWith('year') ? n * 12 : n;
  }
  if (/half a year|six months/.test(q)) return 6;
  return /next year|a year from now/.test(q) ? 12 : undefined;
}

const CAR_TARGET = /\b(?:cars?|auto|vehicle|hatchback|estate|suv|sedan|toyota|volkswagen|volvo|skoda|škoda|hyundai|kia|nissan|honda|tesla|mazda|ford|peugeot|renault|audi|bmw|mercedes|opel|seat|dacia)\b/i;
const BUY = /\b(?:buy(?:ing)?|afford|purchase|save (?:up )?for)\b/i;
// "invest in a car" / «инвестировать в машину» = car purchase goal (not the Invest tab).
const INVEST_CAR = /\binvest(?:ing|ment)?\s+(?:in(?:to)?|to|on)\s+(?:an?\s+|the\s+|my\s+|own\s+)?(?:used\s+|new\s+|big\s+)?(?:cars?|auto|vehicle)\b|инвестир\w*\s+в\s+(?:машин|авто)|влож\w*\s+в\s+(?:машин|авто)/i;
// "invest in/to/into an apartment": a property is a purchase goal (shares and funds are not).
const PROPERTY = /\binvest(?:ing)?\s+(?:in(?:to)?|to|on)\s+(?:an?\s+|the\s+|my\s+|own\s+)?(apartment|flat|house|home|property|real estate|cottage|summer cottage|studio)\b/i;
const RESEARCH = /\b(?:look[ -]?up|research|check (?:current|real|live|listing|market|prices?)|real (?:price|cost)|live (?:prices?|listings?)|(?:find|show|compare) (?:me )?(?:an?|some|the|current|used|new|available)|options|offers|listings)\b/i;

function purchaseName(text: string, verb: string): string | undefined {
  const match = text.match(new RegExp(`\\b(?:${verb})\\s+(?:an?\\s+|the\\s+|my\\s+)?(?:€\\s*[\\d., ]+k?\\s+)?([\\p{L}\\d][\\p{L}\\d '’&–-]{0,59}?)(?=\\s+(?:next|in|by|for|within|this|over|under|with|costing|that|to commute|near)\\b|[?.!,;€]|$)`, 'iu'));
  const name = match?.[1].trim();
  return name && !/^(?:it|this|that|one|another|listings?|options?|prices?|running costs?)$/i.test(name) ? name : undefined;
}

function goalArgs(text: string): Record<string, unknown> {
  const q = text.toLowerCase();
  const named = purchaseName(text, 'buy(?:ing)?|afford|purchase|save (?:up )?for');
  const isCar = CAR_TARGET.test(named ?? q);
  return {
    kind: isCar ? 'car' : 'purchase',
    name: named ?? (isCar ? 'car' : 'purchase'),
    ...(money(q) !== undefined ? { price: money(q) } : {}),
    ...(monthsIn(q) !== undefined ? { months: monthsIn(q) } : {})
  };
}

export function confirmsBrief(text: string): boolean {
  return /^(?:yes|yep|yeah|correct|right|ok(?:ay)?|confirm(?:ed)?|exactly|looks good|sounds good|that(?:'s| is) right)(?:,? (?:that(?:'s| is) right|please|confirm (?:it|the brief)|that looks right))?[.!]?$/i.test(text.trim())
    || /^confirm (?:it|the brief|this brief)[.!]?$/i.test(text.trim());
}

export function approvesPlan(text: string): boolean {
  return /^(?:yes,?\s+)?(?:agree(?: to)? (?:this|the) plan|save (?:this|the|my) plan|i (?:agree(?: to this plan)?|approve(?: this plan)?)|let'?s (?:do (?:it|this)|go with this plan)|go with this plan)[.!]?$/i.test(text.trim());
}

export function approvesRecheck(text: string): boolean {
  return /^(?:yes,?\s+)?(?:please )?(?:re-?check it for me|you may re-?check|keep an eye on\b.+|monitor\b.+|watch\b.+)[.!]?$/i.test(text.trim()) && !/\b(?:don'?t|do not|exclude|except)\b|\?/i.test(text);
}

export function declinesRecheck(text: string): boolean {
  return /\bi will ask myself\b|^don'?t (?:re-?check|monitor|watch)\b|^no\b.*re-?check/i.test(text.trim());
}

export function chosenPath(text: string): string | undefined {
  const pick = text.trim().match(/^(?:i (?:choose|want to) )?(contribute less|reach the goal sooner|keep a larger buffer|reach the goal later)[.!]?$/i)?.[1].toLowerCase();
  return pick ? { c: 'less', k: 'buffer' }[pick[0]] ?? (pick.endsWith('sooner') ? 'sooner' : 'later') : undefined;
}

/** The change a "what if" asks for, as what_if arguments. Empty when the text asks for none. */
function whatIfArgs(q: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const wait = q.match(/wait (?:another |an extra )?(\d+) (?:more |extra )?(months?|years?)/) ?? q.match(/(\d+) (?:more|extra) (months?|years?)/);
  if (wait) args.add_months = Number(wait[1]) * (wait[2].startsWith('year') ? 12 : 1);
  else if (/wait (a|one) year/.test(q)) args.add_months = 12;
  else if (/\bwhat if\b|\binstead\b/.test(q) && monthsIn(q) !== undefined) args.months = monthsIn(q);
  const setTo = q.match(/(?:make it|change it to|let'?s say|rather)\s+(\d+)\s+(months?|years?)/);
  if (setTo) args.months = Number(setTo[1]) * (setTo[2].startsWith('year') ? 12 : 1);

  if (/\b(cut|reduce|lower|trim|spend less|save on)\b/.test(q)) {
    args.cut_group = CUT_WORDS.find(([, words]) => words.test(q))?.[0] ?? 'everyday';
    args.cut_pct = /\bhalf\b/.test(q) ? 50 : firstNumber(q.match(/(\d+(?:[.,]\d+)?)\s?%/)) ?? 20;
  }
  if (/keep (my )?(current|everyday|spending)|no changes|as it is|don'?t change/.test(q)) args.keep_spending = true;

  if (/\b(loan|financ\w*|borrow|credit|instal?lments?)\b/.test(q)) {
    args.loan = !/without|no loan|pay cash|drop the loan/.test(q);
    const years = firstNumber(q.match(/over (\d+) years/));
    if (years !== undefined) args.loan_years = years;
    const rate = args.cut_pct === undefined ? firstNumber(q.match(/(\d+(?:[.,]\d+)?)\s?%/)) : undefined;
    if (rate !== undefined) args.loan_rate_pct = rate;
  }

  const cost = q.match(/(insurance|fuel|charging|maintenance|tyres|tax)\b[^.?!]*?(?:a|per|each|\/)\s?month/);
  const amount = money(q);
  if (cost && amount !== undefined) {
    args.cost_id = { charging: 'fuel', tyres: 'maintenance' }[cost[1]] ?? cost[1];
    args.cost_monthly = amount;
  } else if (amount !== undefined && /cost|price|budget|cheaper|for €|\bcar for\b/.test(q)) {
    args.price = amount;
  }
  return args;
}

// ---- Questions about the user's own data ----

function periodIn(q: string): Period | undefined {
  if (/last month/.test(q)) return 'last_month';
  if (/this month/.test(q)) return 'this_month';
  return /90 days|three months|3 months|quarter/.test(q) ? 'last_90_days' : undefined;
}

function spendingArgs(q: string): Record<string, unknown> | undefined {
  const m = q.match(/(?:spen[dt]|spending|paid|pay) (?:on|for) ([a-zäöå& -]+?)(?=\s+(?:last|this|in|over|during|so far)\b|[?.!,]|$)/);
  if (!m) return undefined;
  const period = periodIn(q);
  return { search: m[1].trim(), ...(period ? { period } : {}) };
}

/** The tool call for a user message, or null when nothing matches (the trainer then asks to clarify). */
export async function ruleCall(text: string, ctx: RuleContext, rules: QuestionClassifier): Promise<ToolCall | null> {
  const q = text.toLowerCase();
  const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ name, args });

  const basket = targetBasket(q);
  const line = basket ? targetLine(q, ctx.lines) : undefined;
  if (basket && line) return call('reclassify', { line_id: line.id, basket });

  if (ctx.hasPlan && declinesRecheck(text)) return call('set_recheck_permission', { allow: false });
  if (ctx.hasPlan && approvesRecheck(text)) {
    const scope = { prices: /\bprices?\b/.test(q), conditions: /\b(?:conditions?|loans?|insurance|rates?)\b/.test(q), spending: /\b(?:spending|cash ?flow)\b/.test(q) };
    if (Object.values(scope).some(Boolean)) return call('set_monitoring', Object.fromEntries(Object.entries(scope).filter(([, value]) => value)));
    if (q.includes('re-check') || q.includes('recheck')) return call('set_recheck_permission', { allow: true });
  }
  if (ctx.pendingBrief && confirmsBrief(text)) return call('confirm_brief');
  const path = ctx.hasPlan && chosenPath(text);
  if (path) return call('choose_path', { id: path });
  if (approvesPlan(text)) return call('agree_plan');
  if (/re-?check|still on track|revisit/.test(q)) return call('recheck_plan');
  if (/other banks?|all (my )?(banks|accounts)|psd2/.test(q)) return call('set_multibank', { on: !/only|exclude|without|hide|remove/.test(q) });

  const change = whatIfArgs(q);
  const rename = ctx.goal && purchaseName(text, 'switch to|change (?:it|the goal) to|make it|instead (?:buy|look for)|look for|find(?: me)?|what about');
  if (rename && !/\b(?:months?|years?|loans?|spending)\b/i.test(rename) && (ctx.goal?.kind === 'purchase' || CAR_TARGET.test(rename))) {
    return call('what_if', { ...change, name: rename });
  }
  if (INVEST_CAR.test(q) && !/\bwhat if\b/.test(q)) {
    return call('simulate_goal', { kind: 'car', name: 'car', ...(money(q) !== undefined ? { price: money(q) } : {}), ...(monthsIn(q) !== undefined ? { months: monthsIn(q) } : {}) });
  }
  const property = q.match(PROPERTY);
  if (property && !/\bwhat if\b/.test(q)) {
    return call('simulate_goal', { kind: 'purchase', name: property[1], ...(money(q) !== undefined ? { price: money(q) } : {}), ...(monthsIn(q) !== undefined ? { months: monthsIn(q) } : {}) });
  }
  if (BUY.test(q) && !/\bwhat if\b/.test(q)) return call('simulate_goal', goalArgs(text));
  if (Object.keys(change).length) return call('what_if', change);

  if (ctx.goal && RESEARCH.test(q)) return call('research_goal');
  const option = ctx.goal && q.match(/^use option (\d+)/);
  if (option) return call('choose_option', { index: Number(option[1]) - 1 });
  if (/safe(ly)?( to)? spend|(what|how much) can i spend/.test(q)) return call('get_safe_to_spend');
  if (/kind of spender|spending (style|habits|profile)|am i (a )?(good |big )?(saver|spender)/.test(q)) return call('get_spending_profile');
  const publicBenchmark = /\b(?:benchmark|on average|average|typical)\b/i.test(q) && !/\b(?:i|my|me)\b/i.test(q);
  const spending = publicBenchmark ? undefined : spendingArgs(q);
  if (spending) return call('query_spending', spending);
  if (/where (did|does|is|has) (all )?my money|baskets?|breakdown|cash ?flow|overview/.test(q)) return call('get_baskets');
  if (/\b(my|the) plan\b/.test(q)) return call('get_plan');
  if (RESEARCH.test(q) || /benchmark|on average|average|typical|compare/.test(q)) {
    // General web search has no need for details about the customer's own accounts.
    if (/\b(?:iban|account number|i earn|i get paid|my (?:income|salary|balance|transactions?|accounts?|budget|address))\b|\b\S+@\S+\.\S+\b/i.test(text)) return null;
    return call('search_web', { query: `${text.trim()} Finland` });
  }

  // The coach's own questions (scenarios in the 3D City, the rent letter).
  const route = await rules.classify(text);
  if (route.intent === 'forecast' || route.intent === 'action') return call('ask_coach', { id: route.id });
  if (route.id === 'safe_to_spend') return call('get_safe_to_spend');
  if (route.id === 'taxi_total') return call('query_spending', { search: 'taxi' });
  if (route.id === 'breakdown') return call('get_baskets');
  return null;
}
