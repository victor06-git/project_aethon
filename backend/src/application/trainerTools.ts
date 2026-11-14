// The trainer's tools: everything the agent can do with the user's data, a goal, the web
// and the agreed plan. Gemini calls them by function calling; without a model the rules call
// the same tools; the UI calls them directly for buttons and sliders. Each tool returns an
// answer (text computed here, plus cards) and the new state. Arguments are untrusted.
import { httpError, type Answer, type Transaction } from '../domain/types';
import { round2 } from '../domain/money';
import { INTENTS } from '../domain/intents';
import { longDate, monthsBetween } from '../domain/dates';
import { buildCashflow } from '../domain/cashflow';
import { PERIOD_LABEL, PERIODS, querySpending, spendingProfile } from '../domain/spending';
import { RUNNING_COST_IDS, applyWhatIf, cutGain, newGoal, planChoices, simulate, type WhatIf } from '../domain/goals';
import {
  CUT_GROUPS, LIMITS, LINE_BASKETS, NO_MONITORING, eur, hostOf as host,
  type AgreedPlan, type BenchmarkUnit, type CashLine, type Cashflow, type GoalDraft, type LineBasket, type Monitoring, type NextStep,
  type PlanStatus, type Source, type TrainerState
} from '../domain/trainer';
import { evidenceQuote, researchGoal, watchGoal, type Watch } from './goalResearch';
import type { CoachService } from './coachService';
import type { ExternalAccounts, ResearchProvider, ToolCall, ToolSpec, TransactionRepository } from './ports';

export interface Session { state: TrainerState; sources: Source[] }          // sources found during this request
export interface ToolOutcome { answer: Answer; state: TrainerState; sources?: Source[]; activity?: string[] }   // activity: what the tool did, for the trace
export interface TrainerContext { cashflow: Cashflow; transactions: Transaction[]; savings: number; asOf: string }

interface Deps { transactions: TransactionRepository; external: ExternalAccounts; coach: CoachService; research: ResearchProvider | null; log?: (msg: string) => void }
type Args = Record<string, unknown>;
type Handler = (args: Args, session: Session, ctx: TrainerContext) => ToolOutcome | Promise<ToolOutcome>;

const REVIEW_LINES = 3;
const DEFAULT_CUT_PCT = 20;
const CHANGE_MIN_EUR = 5;           // smaller differences are not worth reporting in a re-check
const AT_RISK_SHARE = 0.2;          // short by up to this share of the monthly saving is "at risk"
const QUERY_LENGTH = { min: 3, max: 200 };
const NOTE_MAX = 300;
const MONITOR_KEYS = ['prices', 'conditions', 'spending'] as const;
const BASKET_NAME: Record<LineBasket, string> = {
  regular: 'mandatory & regular', irregular: 'mandatory & irregular', everyday: 'everyday spending', oneoff: 'a one-off'
};
const STATUS_TEXT: Record<PlanStatus, string> = {
  on_track: 'Your plan is on track.', at_risk: 'Your plan is at risk.', off_track: 'Your plan no longer adds up.'
};
const TOPICS: Record<string, { label: string; units: BenchmarkUnit[] }> = {
  price: { label: 'Typical price', units: ['eur'] },
  insurance: { label: 'Insurance', units: ['eur_per_month', 'eur_per_year'] },
  fuel: { label: 'Fuel or charging', units: ['eur_per_month', 'eur_per_year'] },
  maintenance: { label: 'Maintenance and tyres', units: ['eur_per_month', 'eur_per_year'] },
  tax: { label: 'Vehicle tax', units: ['eur_per_month', 'eur_per_year'] },
  loan_rate: { label: 'Loan interest rate', units: ['percent'] }
};
const COACH_IDS = [...Object.keys(INTENTS.forecast), ...Object.keys(INTENTS.action)];
const RESEARCH_OFF = 'Live web research is unavailable in this session (no EXA_API_KEY on the server). The plan uses the amounts shown in its cost breakdown.';
const WHAT_IF_CHIPS = ['What if I wait 3 more months?', 'What if I cut dining out by 20%?', 'What if I take a loan?'];

// ---- Argument checks ----

const bad = (message: string) => httpError(400, message);
const given = (v: unknown) => v !== undefined && v !== null;

function optNumber(args: Args, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (!given(v)) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${key} must be a number between ${min} and ${max}`);
  return v;
}

function optString(args: Args, key: string, max = 120): string | undefined {
  const v = args[key];
  if (!given(v)) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${key} must be a short text`);
  return v.trim();
}

function optEnum<T extends string>(args: Args, key: string, allowed: readonly T[]): T | undefined {
  const v = args[key];
  if (!given(v)) return undefined;
  if (!allowed.includes(v as T)) throw bad(`${key} must be one of: ${allowed.join(', ')}`);
  return v as T;
}

function optBool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (!given(v)) return undefined;
  if (typeof v !== 'boolean') throw bad(`${key} must be true or false`);
  return v;
}

function need<T>(value: T | undefined, key: string): T {
  if (value === undefined) throw bad(`${key} is required`);
  return value;
}

// ---- Answers (the text computed by the app; Gemini may rephrase it, never the figures) ----

export const allLines = (c: Cashflow): CashLine[] => [...c.baskets.flatMap((b) => b.lines), ...c.oneOffs];
const assumed = (c: Cashflow): CashLine[] => allLines(c).filter((l) => l.basis === 'assumed').slice(0, REVIEW_LINES);
const exactEur = (amount: number): string => `€${amount.toLocaleString('en-GB', { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2 })}`;

function safeAnswer(c: Cashflow): Answer {
  const s = c.safe;
  return {
    type: 'cashflow', figure: eur(s.week),
    text: `From your ${longDate(c.asOf)} statement, the estimate for how much you can safely spend over the following week is **${eur(s.week)}**. `
      + `It uses cash already on hand after upcoming bills and an irregular-cost reserve, until the estimated payday on ${longDate(s.until)}. `
      + `Your repeatable savings capacity from monthly income and spending is about ${eur(c.safeToSave)} a month.`,
    steps: s.steps, review: assumed(c), followUps: ['Where did my money go?', 'Could I buy a car next year?']
  };
}

function basketsAnswer(c: Cashflow, intro = ''): Answer {
  const [regular, irregular, everyday] = c.baskets;
  const left = c.free >= 0
    ? `That leaves about **${eur(c.safeToSave)}** a month for savings or goals.`
    : `That is about **${eur(-c.free)}** a month more than comes in.`;
  return {
    type: 'cashflow',
    text: `${intro}About **${eur(c.income)}** comes in each month. **${eur(regular.monthly)}** goes to mandatory regular bills, `
      + `**${eur(irregular.monthly)}** to mandatory irregular costs and **${eur(everyday.monthly)}** to everyday spending. `
      + (c.transferReserve ? `I also reserve **${eur(c.transferReserve)}** for monthly salary sweeps outside these accounts. ` : '')
      + (c.investmentMonthly > 0 ? `You have invested about ${eur(c.investmentMonthly)} a month on average. That comes from the amount left for savings and goals. ` : '')
      + `${left} Based on ${longDate(c.periodFrom)} to ${longDate(c.asOf)}.`,
    baskets: c.baskets, review: assumed(c), followUps: ['What kind of spender am I?', 'What can I safely spend this week?']
  };
}

function goalAnswer(goal: GoalDraft, ctx: TrainerContext, intro = ''): Answer {
  const sim = simulate(goal, ctx);
  const plan = sim.scenarios[0];
  const price = `${eur(goal.price)}${goal.priceSource === 'assumption' ? ' (my assumption)' : ''}`;
  const what = `**${goal.name}** for ${price} in ${goal.months} months`;
  let text: string;
  if (plan.loan) {
    text = `With a loan: you save ${eur(plan.monthlyNeeded)} a month for ${goal.months} months and borrow ${eur(plan.loan.amount)}. `
      + `After buying, the loan and running costs come to **${eur(plan.afterMonthly)} a month**, and you free up about ${eur(plan.monthlyCapacity)}. `
      + (plan.feasible ? 'That fits.' : `That is ${eur(-plan.afterFree)} a month too much.`);
  } else if (plan.feasible) {
    text = `Yes, it fits: ${what} means saving **${eur(plan.monthlyNeeded)} a month**, and you free up about ${eur(plan.monthlyCapacity)}.`;
  } else if (plan.gap > 0) {
    text = `Not yet at today's spending: ${what} needs **${eur(plan.monthlyNeeded)} a month**, and you free up about ${eur(plan.monthlyCapacity)}.`;
  } else {
    text = `You can save for ${what}, but running it costs ${eur(plan.afterMonthly)} a month and you free up about ${eur(plan.monthlyCapacity)}.`;
  }
  const cushion = sim.cushion > 0 ? ` I counted ${eur(sim.start)} of your savings and left ${eur(sim.cushion)} untouched as a cushion.` : '';
  const upfront = ` On the day you need ${eur(plan.upfront)} upfront.`;
  const assumptions = goal.running.some((c) => c.source === 'assumption') ? ' Running costs are typical figures until we look them up.' : '';
  const investment = ctx.cashflow.investmentMonthly > 0 ? ` This uses room before investment contributions. You invested about ${eur(ctx.cashflow.investmentMonthly)} a month on average.` : '';
  return {
    type: 'scenario', text: `${intro}${text}${upfront}${cushion}${assumptions}${investment}`, goal, scenarios: sim.scenarios,
    nextStep: nextStepFor(sim.scenarios, ctx), ...(sim.fixes.length ? { fixes: sim.fixes } : {}),
    followUps: plan.feasible ? ['Agree this plan', 'Research with Exa'] : ['Research with Exa']
  };
}

/** The prepared next step: the transfer that starts the plan, or the closest option that fits. */
function nextStepFor(scenarios: Answer['scenarios'] & object, ctx: TrainerContext): NextStep | undefined {
  const [plan, ...others] = scenarios;
  if (plan.feasible) {
    return {
      title: 'Prepared next step', ask: 'Agree this plan',
      detail: `A monthly transfer of ${eur(plan.monthlyNeeded)} to your savings, starting on payday, ${longDate(ctx.cashflow.safe.until)}. Agree the plan and I set it aside for you.`
    };
  }
  const fits = others.find((s) => s.feasible);
  if (!fits) return undefined;
  return {
    title: 'Closest option that fits', ask: `What if I wait ${fits.months - plan.months} more months?`,
    detail: `${fits.label}: ${eur(fits.monthlyNeeded)} a month, ready on ${longDate(fits.readyDate)}.`
  };
}

/** The brief: what the trainer understood, shown for confirmation before anything is simulated. */
function briefAnswer(goal: GoalDraft, ctx: TrainerContext, intro = ''): Answer {
  const sim = simulate(goal, ctx);
  const running = goal.running.reduce((s, c) => s + c.monthly, 0);
  const lines = [
    `- **Goal:** ${goal.name}`,
    goal.price > 0
      ? `- **Budget:** ${eur(goal.price)}${goal.priceSource === 'assumption' ? ' (my assumption: tell me yours)' : ''}`
      : '- **Budget:** not set yet. Tell me a price, for example €3,000.',
    `- **When:** in ${goal.months} months, by ${longDate(sim.scenarios[0].readyDate)}`,
    `- **From your accounts:** about ${eur(sim.capacity)} free each month${ctx.cashflow.investmentMonthly > 0 ? ' before investing' : ''} and ${eur(sim.start)} of savings to use`,
    running > 0 ? `- **After buying:** about ${eur(running)} a month to run it (typical figures, to be researched)` : '- **After buying:** no ongoing costs counted',
    ...(goal.note ? [`- **Your situation:** ${goal.note}`] : [])
  ];
  return {
    type: 'brief', goal, text: `${intro}Here is the brief as I understand it:\n${lines.join('\n')}\nIs this right?`,
    followUps: goal.price > 0 ? ['Yes, that is right', 'Make it 18 months', 'The budget is €12,000'] : ['Research with Exa', 'The budget is €3,000']
  };
}

/** A goal is shown as a brief until the user confirms it, then as a simulation. */
const showGoal = (goal: GoalDraft, ctx: TrainerContext, intro = ''): Answer => (goal.confirmed ? goalAnswer(goal, ctx, intro) : briefAnswer(goal, ctx, intro));

const chat = (text: string, followUps: string[] = []): Answer => ({ type: 'chat', text, followUps });
const NO_GOAL = () => chat('Tell me what you are thinking about first, for example "Could I buy a car next year?"', ['Could I buy a car next year?']);
const NO_PLAN = () => chat('There is no agreed plan yet. Explore a goal first, then agree on it.', ['Could I buy a car next year?']);

// ---- Tool handlers ----

function whatIfFrom(args: Args): WhatIf {
  const cutGroup = optString(args, 'cut_group', 60);
  const cutPct = optNumber(args, 'cut_pct', 0, 100);
  const loan = optBool(args, 'loan');
  const years = optNumber(args, 'loan_years', 1, LIMITS.loanYears);
  const ratePct = optNumber(args, 'loan_rate_pct', 0, LIMITS.ratePct);
  const amount = optNumber(args, 'loan_amount', 0, LIMITS.price);
  const costId = optEnum(args, 'cost_id', RUNNING_COST_IDS);
  const costMonthly = optNumber(args, 'cost_monthly', 0, LIMITS.monthly);
  const wantsLoan = loan === true || (loan === undefined && (years !== undefined || ratePct !== undefined || amount !== undefined));
  return {
    name: optString(args, 'name', 60),
    months: optNumber(args, 'months', 1, LIMITS.months),
    addMonths: optNumber(args, 'add_months', -LIMITS.months, LIMITS.months),
    price: optNumber(args, 'price', 1, LIMITS.price),
    keepSpending: optBool(args, 'keep_spending'),
    cut: cutGroup || cutPct !== undefined ? { group: cutGroup ?? 'everyday', pct: cutPct ?? DEFAULT_CUT_PCT } : undefined,
    loan: loan === false ? false : wantsLoan ? { ...(years !== undefined ? { years } : {}), ...(ratePct !== undefined ? { ratePct } : {}), ...(amount !== undefined ? { amount } : {}) } : undefined,
    cost: costId && costMonthly !== undefined ? { id: costId, monthly: costMonthly } : undefined
  };
}

/** A cut may name 'everyday', a group, or any everyday category of the user's own data. Returns the name to store. */
function cutTarget(group: string, cashflow: Cashflow): string {
  const name = group.trim().toLowerCase();
  if (name === 'everyday' || CUT_GROUPS[name]) return name;
  const lines = cashflow.baskets.find((b) => b.basket === 'everyday')?.lines ?? [];
  const hit = lines.find((l) => l.category.toLowerCase() === name || l.label.toLowerCase() === name);
  if (hit) return hit.category;
  const known = [...new Set(lines.map((l) => l.category))];
  throw bad(`Unknown spending category "${group}". Choose from: ${known.join(', ')}, or everyday`);
}

function checkPlan(plan: AgreedPlan, ctx: TrainerContext, outside: string[] = [], proposedGoal?: GoalDraft, gaps: string[] = []): { plan: AgreedPlan; answer: Answer } {
  const now = planToday(plan, ctx, proposedGoal);
  const changes: string[] = [];
  const freed = now.monthlyCapacity - plan.capacityAtAgreement;
  if (Math.abs(freed) >= CHANGE_MIN_EUR) {
    changes.push(`You now free up ${eur(now.monthlyCapacity)} a month, ${eur(Math.abs(freed))} ${freed > 0 ? 'more' : 'less'} than when we agreed.`);
  }
  if (Math.abs(now.monthlyNeeded - plan.monthlySaving) >= CHANGE_MIN_EUR) {
    changes.push(`To be ready by ${longDate(plan.targetDate)} you now need ${eur(now.monthlyNeeded)} a month (agreed: ${eur(plan.monthlySaving)}).`);
  }
  changes.push(...outside);
  // Choices are offered when something actually changed: the decision stays with the user.
  const choices = changes.length ? planChoices(now, ctx.asOf) : [];
  if (!changes.length) changes.push(gaps.length ? 'No change was verified in the information I could check.' : 'Nothing has changed since we agreed this plan.');
  changes.push(...gaps);
  const status: PlanStatus = now.feasible ? 'on_track' : now.gap <= now.monthlyNeeded * AT_RISK_SHARE ? 'at_risk' : 'off_track';
  const checked: AgreedPlan = { ...plan, lastCheck: { checkedOn: ctx.asOf, status, changes, ...(proposedGoal ? { proposedGoal } : {}) } };
  const ask = choices.length ? '\nYou decide what to do with it:' : '';
  return {
    plan: checked,
    answer: {
      type: 'plan', text: `${proposedGoal ? `If the verified market changes apply: ${STATUS_TEXT[status]} Your saved amounts stay as agreed until you choose.` : STATUS_TEXT[status]}\n${changes.map((c) => `- ${c}`).join('\n')}${ask}`, plan: checked, scenarios: [now],
      ...(choices.length ? { choices } : {}),
      followUps: status === 'on_track' ? [] : WHAT_IF_CHIPS.slice(0, 2)
    }
  };
}

/** The agreed goal on today's figures, for the time left until the target date. */
function planToday(plan: AgreedPlan, ctx: TrainerContext, goal = plan.goal) {
  const months = Math.max(1, monthsBetween(ctx.asOf, plan.targetDate));
  return simulate({ ...goal, months }, ctx).scenarios[0];
}

function marketProposal(goal: GoalDraft, watch: Watch | null): GoalDraft | undefined {
  const { price, rate } = watch ?? {};
  if (!price && !(rate && goal.loan)) return undefined;
  const benchmarks = [...goal.benchmarks];
  function add(topic: string, unit: BenchmarkUnit, evidence: NonNullable<Watch['price']>) {
    const index = benchmarks.findIndex((b) => b.topic === topic);
    if (index >= 0) benchmarks.splice(index, 1);
    benchmarks.push({ topic, label: TOPICS[topic].label, value: evidence.value, unit, quote: evidence.quote, url: evidence.source.url, sources: [evidence.source] });
  }
  if (price) add('price', 'eur', price);
  if (rate && goal.loan) add('loan_rate', 'percent', rate);
  return {
    ...goal, benchmarks,
    ...(price ? { price: price.value, priceSource: 'research' as const } : {}),
    ...(rate && goal.loan ? { loan: { ...goal.loan, ratePct: rate.value, rateSource: 'research' as const, rateUrl: rate.source.url } } : {})
  };
}

export function createTrainerTools({ transactions, external, coach, research, log = () => {} }: Deps) {
  function context(state: TrainerState): TrainerContext {
    const asOf = transactions.asOf();
    const list = state.multiBank ? [...transactions.list(), ...external.transactions(asOf)] : transactions.list();
    const accounts = state.multiBank ? [...transactions.accounts(), ...external.accounts()] : transactions.accounts();
    const cashflow = buildCashflow({ transactions: list, accounts, asOf, corrections: state.corrections, planMonthly: (state.plan?.monthlySaving ?? 0) + (state.plan?.bufferMonthly ?? 0) });
    const savings = round2(accounts.filter((a) => a.kind === 'savings').reduce((s, a) => s + a.balance, 0));
    return { cashflow, transactions: list, savings, asOf };
  }

  const handlers: Record<string, Handler> = {
    get_safe_to_spend: (_, { state }, ctx) => ({ answer: safeAnswer(ctx.cashflow), state }),

    get_baskets: (_, { state }, ctx) => ({ answer: basketsAnswer(ctx.cashflow), state }),

    query_spending: (args, { state }, ctx) => {
      const search = need(optString(args, 'search'), 'search');
      const q = querySpending(ctx.transactions, ctx.asOf, search, optEnum(args, 'period', PERIODS));
      const when = PERIOD_LABEL[q.period];
      const range = `${longDate(q.from)} to ${longDate(q.to)}`;
      const refunds = q.refunds ? ` This total includes ${q.refunds} refund${q.refunds === 1 ? '' : 's'}.` : '';
      const matched = q.count + q.refunds > 0;
      const result = q.total < 0 ? `You received **${exactEur(-q.total)}** back overall on ${search}` : `You spent **${exactEur(q.total)}** on ${search}`;
      const text = matched
        ? `${result} ${when} (${range}), across ${q.count} payment${q.count === 1 ? '' : 's'}.${refunds}`
        : `I found no payments for "${search}" ${when} (${range}).`;
      return { answer: { type: 'cashflow', text, figure: matched ? exactEur(q.total) : undefined, rows: q.payees }, state };
    },

    get_spending_profile: (_, { state }, ctx) => {
      const p = spendingProfile(ctx.cashflow, ctx.transactions, ctx.asOf);
      if (ctx.cashflow.income <= 0) return { answer: basketsAnswer(ctx.cashflow, 'I could not identify regular income from this history. '), state };
      const [regular, irregular, everyday] = p.shares;
      const top = p.topEveryday.map((t) => `${t.label} (${eur(t.amount)})`).join(', ');
      const text = `${p.style}. Of every €100 that comes in, about €${regular.pct} goes to mandatory regular bills, €${irregular.pct} to mandatory irregular costs, `
        + `€${everyday.pct} to everyday spending. `
        + (ctx.cashflow.transferReserve ? `About €${Math.round(ctx.cashflow.transferReserve * 100 / ctx.cashflow.income)} is reserved for salary sweeps. ` : '')
        + (p.savingRatePct >= 0 ? `About €${p.savingRatePct} is left. ` : `Spending and transfers exceed income by €${-p.savingRatePct} per €100 earned. `)
        + (top ? `Your biggest everyday categories each month: ${top}. ` : '')
        + `Everyday spending in the last 30 days: ${eur(p.everydayLast30)} (the 30 days before: ${eur(p.everydayPrevious30)}).`;
      return { answer: { type: 'cashflow', text, rows: p.topEveryday, baskets: ctx.cashflow.baskets }, state };
    },

    reclassify: (args, { state }, ctx) => {
      const lineId = need(optString(args, 'line_id'), 'line_id');
      const basket = need(optEnum(args, 'basket', [...LINE_BASKETS, 'one_off'] as const), 'basket');
      const as: LineBasket = basket === 'one_off' ? 'oneoff' : basket;
      const line = allLines(ctx.cashflow).find((l) => l.id === lineId);
      if (!line) throw bad(`Unknown line_id "${lineId}". Known ids: ${allLines(ctx.cashflow).map((l) => l.id).join(', ')}`);
      const next = { ...state, corrections: [...state.corrections.filter((c) => c.lineId !== lineId), { lineId, as }] };
      const after = context(next).cashflow;
      const text = `Done: **${line.label}** (${eur(line.lastAmount)}) now counts as ${BASKET_NAME[as]}, not ${BASKET_NAME[line.basket]}. `
        + `Safe to spend this week: ${eur(ctx.cashflow.safe.week)} → **${eur(after.safe.week)}**. `
        + `Left each month: ${eur(ctx.cashflow.free)} → **${eur(after.free)}**.`;
      return { answer: { type: 'cashflow', text, figure: eur(after.safe.week), steps: after.safe.steps, baskets: after.baskets }, state: next,
        activity: [`${line.label}: ${BASKET_NAME[line.basket]} → ${BASKET_NAME[as]}`, `Safe to spend: ${eur(ctx.cashflow.safe.week)} → ${eur(after.safe.week)}`] };
    },

    simulate_goal: (args, { state }, ctx) => {
      const kind = optEnum(args, 'kind', ['car', 'purchase'] as const) ?? 'purchase';
      const name = optString(args, 'name', 60) ?? (kind === 'car' ? 'car' : 'purchase');
      const draft = newGoal(kind, name, optNumber(args, 'price', 1, LIMITS.price), optNumber(args, 'months', 1, LIMITS.months), optString(args, 'note', NOTE_MAX));
      return { answer: briefAnswer(draft, ctx), state: { ...state, draft } };
    },

    confirm_brief: (_, { state }, ctx) => {
      if (!state.draft) return { answer: NO_GOAL(), state };
      if (state.draft.price <= 0) return { answer: briefAnswer(state.draft, ctx, 'One thing is missing: the budget. '), state };
      const draft = { ...state.draft, confirmed: true };
      return { answer: goalAnswer(draft, ctx, 'Brief confirmed. '), state: { ...state, draft } };
    },

    what_if: (args, { state }, ctx) => {
      const change = whatIfFrom(args);
      if (change.cut) change.cut = { ...change.cut, group: cutTarget(change.cut.group, ctx.cashflow) };
      const base = state.draft ?? state.plan?.goal;
      if (!base) {
        if (!change.cut || change.cut.pct <= 0) return { answer: NO_GOAL(), state };
        const gain = cutGain([change.cut], ctx.cashflow);
        const text = `Cutting ${CUT_GROUPS[change.cut.group]?.label ?? change.cut.group.toLowerCase()} by ${change.cut.pct}% would free about **${eur(gain)} a month**, ${eur(gain * 12)} a year.`;
        return { answer: { type: 'cashflow', text, figure: `${eur(gain)} a month`, followUps: ['Could I buy a car next year?'] }, state };
      }
      const draft = applyWhatIf(base, change);
      return { answer: showGoal(draft, ctx), state: { ...state, draft } };
    },

    search_web: async (args, { state }) => {
      const query = need(optString(args, 'query', QUERY_LENGTH.max), 'query');
      if (query.length < QUERY_LENGTH.min) throw bad('query is too short');
      if (!research) return { answer: { type: 'research', text: RESEARCH_OFF }, state };
      let sources: Source[];
      try {
        sources = await research.search(query);
      } catch (error) {
        log(`search_web failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
          answer: { type: 'research', text: 'Exa could not complete this search. Try again in a moment.' },
          state, activity: [`Asked Exa: ${query}`, 'Exa did not complete the search.']
        };
      }
      const text = sources.length
        ? `I found ${sources.length} source${sources.length === 1 ? '' : 's'} for "${query}": ${[...new Set(sources.map((s) => host(s.url)))].join(', ')}.`
        : `I found nothing reliable for "${query}".`;
      return { answer: { type: 'research', text, sources }, state, sources, activity: [`Asked Exa: ${query}`] };
    },

    research_goal: async (_, { state }, ctx) => {
      const goal = state.draft ?? state.plan?.goal;
      if (!goal) return { answer: NO_GOAL(), state };
      if (!goal.confirmed && goal.price > 0) return { answer: briefAnswer(goal, ctx, 'Confirm the brief to research this goal. '), state };
      if (!research) return { answer: { ...showGoal(goal, ctx), type: 'research', text: RESEARCH_OFF }, state };
      const r = await researchGoal(goal, new Date().getUTCFullYear().toString(), research, log);
      const shown = showGoal(r.goal, ctx);
      const previous = goal.confirmed ? simulate(goal, ctx).scenarios[0] : undefined;
      const current = shown.scenarios?.[0];
      const next = { ...state, draft: r.goal };
      const lines = [
        ...r.found.map((f) => `- ${f}`),
        ...(r.missing.length ? [`- No source stated clearly: ${r.missing.join(', ')}. The plan keeps the amounts already shown for those costs.`] : []),
        ...(r.failed.length ? [`- Exa could not check ${r.failed.join(', ')}. You can retry the search.`] : []),
        ...(r.goal.options.length ? ['Pick a listing to see what its price would mean for your plan. Confirm the price and availability with the seller before committing.'] : []),
        ...(previous && current && previous.monthlyNeeded !== current.monthlyNeeded
          ? [`The same timeline now needs **${eur(current.monthlyNeeded)} a month** in savings (previously ${eur(previous.monthlyNeeded)}).`] : []),
        ...(previous && current && previous.afterMonthly !== current.afterMonthly
          ? [`After buying, the estimate is now **${eur(current.afterMonthly)} a month** (previously ${eur(previous.afterMonthly)}).`] : []),
        ...(state.plan && !state.draft ? ['Review this draft and save it if you want to update your agreed plan.'] : []),
        ...(!r.goal.confirmed && r.goal.price > 0 ? ['Confirm the draft budget and timeline to calculate your savings plan.'] : [])
      ];
      const intro = r.found.length
        ? `I researched **${goal.name}** with Exa (${r.sources.length} sources).`
        : r.failed.length === r.queries.length
          ? 'Exa could not complete the searches for this goal.'
          : 'The Exa search returned no verified figures for this goal.';
      const text = [intro, ...lines].join('\n');
      return { answer: { ...shown, type: 'research', text, sources: r.sources }, state: next, sources: r.sources, activity: r.queries.map((q) => `Asked Exa: ${q}`) };
    },

    choose_option: (args, { state }, ctx) => {
      const goal = state.draft ?? state.plan?.goal;
      if (!goal) return { answer: NO_GOAL(), state };
      const picked = goal.options[need(optNumber(args, 'index', 0, Math.max(0, goal.options.length - 1)), 'index')];
      if (!picked) throw bad('There is no such option: run research_goal first');
      const benchmark = {
        topic: 'price', label: 'Listing price', value: picked.price, unit: 'eur' as const, url: picked.url,
        sources: picked.evidence ? [picked.evidence] : [],
        ...(picked.evidence ? { quote: picked.evidence.snippet } : {})
      };
      const draft: GoalDraft = {
        ...goal, price: picked.price, priceSource: 'research', selectedOptionUrl: picked.url,
        benchmarks: [...goal.benchmarks.filter((b) => b.topic !== 'price'), benchmark]
      };
      return {
        answer: { ...showGoal(draft, ctx, `Using ${picked.name} at ${eur(picked.price)} (${host(picked.url)}). `), ...(picked.evidence ? { sources: [picked.evidence] } : {}) },
        state: { ...state, draft }
      };
    },

    apply_benchmark: (args, session, ctx) => {
      const topic = need(optEnum(args, 'topic', Object.keys(TOPICS)), 'topic');
      const unit = need(optEnum(args, 'unit', TOPICS[topic].units), 'unit');
      const value = need(optNumber(args, 'value', 0, LIMITS.price), 'value');
      const url = need(optString(args, 'source_url', 500), 'source_url');
      const quote = need(optString(args, 'quote', 400), 'quote');
      const goal = session.state.draft ?? session.state.plan?.goal;
      if (!goal) throw bad('There is no goal yet: call simulate_goal first');
      // A figure enters the plan only if its source says it: same URL, same words, same number.
      const source = session.sources.find((s) => s.url === url);
      if (!source) throw bad('source_url must be a URL returned by search_web in this turn');
      const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!squash(source.snippet).includes(squash(quote))) throw bad('quote must be copied word for word from that source');
      if (!evidenceQuote(quote, value, unit)) throw bad('the quote must state the value and its currency or unit');

      const monthly = unit === 'eur_per_year' ? round2(value / 12) : value;
      const keptPrice = topic === 'price' && (goal.priceSource === 'user' || Boolean(goal.selectedOptionUrl));
      const keptFigure = keptPrice || (topic === 'loan_rate' && goal.loan?.rateSource === 'user')
        || goal.running.some((c) => c.id === topic && c.source === 'user');
      const benchmarkTopic = keptPrice ? 'market_price' : topic;
      const benchmark = { topic: benchmarkTopic, label: TOPICS[topic].label, sources: [source], value, unit, quote, url };
      const updated: GoalDraft = {
        ...goal,
        benchmarks: [...goal.benchmarks.filter((b) => b.topic !== benchmarkTopic), benchmark],
        ...(topic === 'price' && !keptPrice ? { price: value, priceSource: 'research' as const } : {}),
        ...(topic === 'loan_rate' && goal.loan && goal.loan.rateSource !== 'user' ? { loan: { ...goal.loan, ratePct: value, rateSource: 'research' as const, rateUrl: url } } : {}),
        running: goal.running.map((c) => (c.id === topic && c.source !== 'user' ? { ...c, monthly, source: 'research' as const, url } : c))
      };
      const shown = unit === 'percent' ? `${value}%` : unit === 'eur' ? eur(value) : `${eur(monthly)} a month`;
      const state = { ...session.state, draft: updated };
      const intro = `From ${host(url)}, the ${TOPICS[topic].label.toLowerCase()} is ${shown}. `
        + (keptFigure ? 'The plan keeps the amount already shown. ' : '');
      return { answer: showGoal(updated, ctx, intro), state };
    },

    agree_plan: (args, { state }, ctx) => {
      if (!state.draft) return { answer: state.plan ? chat('Your plan is already agreed. Change something first if you want a new one.') : NO_GOAL(), state };
      if (!state.draft.confirmed) return { answer: briefAnswer(state.draft, ctx, 'Let us confirm the brief first. '), state };
      const sim = simulate(state.draft, ctx);
      const chosen = sim.scenarios[0];
      if (!chosen.feasible) {
        const text = `This plan does not add up yet. ${chosen.notes[0] ?? ''} Try waiting longer, a cheaper option or a cut first.`;
        return { answer: { type: 'scenario', text, goal: state.draft, scenarios: sim.scenarios, followUps: WHAT_IF_CHIPS }, state };
      }
      const plan: AgreedPlan = {
        goal: state.draft, agreedOn: ctx.asOf, targetDate: chosen.readyDate, monthlySaving: chosen.monthlyNeeded,
        bufferMonthly: 0, capacityAtAgreement: chosen.monthlyCapacity,
        monitor: optBool(args, 'allow_recheck') ? { prices: true, conditions: true, spending: true } : NO_MONITORING, lastCheck: null
      };
      const text = `Agreed: save **${eur(plan.monthlySaving)} a month** until ${longDate(plan.targetDate)} for ${plan.goal.name}. `
        + `I set that aside before working out your safe-to-spend. When you open the plan, I can recheck prices${plan.goal.loan ? ', loan terms' : ''} and spending with your permission.`;
      const nextStep: NextStep = {
        title: 'Prepared next step', screen: 'transfer',
        detail: `Set up a monthly transfer of ${eur(plan.monthlySaving)} from your current account to savings, from ${longDate(ctx.cashflow.safe.until)}. Nothing is moved until you do it.`
      };
      return { answer: { type: 'plan', text, plan, nextStep, followUps: ['Yes, re-check it for me', 'No, I will ask myself'] }, state: { ...state, draft: null, plan } };
    },

    set_recheck_permission: (args, { state }) => {
      if (!state.plan) return { answer: NO_PLAN(), state };
      const allow = need(optBool(args, 'allow'), 'allow');
      const plan = { ...state.plan, monitor: { prices: allow, conditions: allow, spending: allow } };
      const text = allow ? `I’ll check prices${plan.goal.loan ? ', loan terms' : ''} and spending when you reopen this plan.` : 'I’ll re-check your plan only when you ask.';
      return { answer: { type: 'plan', text, plan }, state: { ...state, plan } };
    },

    set_monitoring: (args, { state }) => {
      if (!state.plan) return { answer: NO_PLAN(), state };
      const monitor: Monitoring = { ...state.plan.monitor };
      for (const key of MONITOR_KEYS) monitor[key] = optBool(args, key) ?? monitor[key];
      const plan = { ...state.plan, monitor };
      const watched = MONITOR_KEYS.filter((key) => monitor[key] && (key !== 'conditions' || plan.goal.loan)).map((key) => key === 'conditions' ? 'loan terms' : key);
      const text = watched.length ? `When you reopen this plan, I’ll check ${watched.join(', ')}.` : 'I’ll re-check your plan only when you ask.';
      return { answer: { type: 'plan', text, plan }, state: { ...state, plan } };
    },

    choose_path: (args, { state }, ctx) => {
      if (!state.plan) return { answer: NO_PLAN(), state };
      const id = need(optEnum(args, 'id', ['less', 'sooner', 'buffer', 'later'] as const), 'id');
      const goal = state.plan.lastCheck?.proposedGoal ?? state.plan.goal;
      const now = planToday(state.plan, ctx, goal);
      const choice = planChoices(now, ctx.asOf).find((c) => c.id === id);
      if (!choice) throw bad(`"${id}" is not available for this plan right now`);
      const plan: AgreedPlan = {
        ...state.plan, goal, monthlySaving: choice.monthlySaving, bufferMonthly: choice.bufferMonthly, targetDate: choice.targetDate,
        capacityAtAgreement: now.monthlyCapacity,
        lastCheck: { checkedOn: ctx.asOf, status: 'on_track', changes: [`You chose: ${choice.label.toLowerCase()}.`] }
      };
      return { answer: { type: 'plan', text: `Done. ${choice.detail}`, plan }, state: { ...state, plan } };
    },

    recheck_plan: async (_, { state }, ctx) => {
      if (!state.plan) return { answer: NO_PLAN(), state };
      // What the user approved to be monitored is looked up again on the web.
      const watch = research ? await watchGoal(state.plan.goal, state.plan.monitor, String(new Date().getUTCFullYear()), research, log) : null;
      const gaps = [
        ...(watch?.missing.length ? [`No usable source for ${watch.missing.join(', ')}. The saved assumptions still apply there.`] : []),
        ...(watch?.failed.length ? [`Exa could not complete the check for ${watch.failed.join(', ')}. You can try again.`] : []),
        ...(!research && (state.plan.monitor.prices || (state.plan.monitor.conditions && state.plan.goal.loan)) ? ['Live Exa checks are unavailable. Market assumptions were kept.'] : [])
      ];
      const { plan, answer } = checkPlan(state.plan, ctx, watch?.changes, marketProposal(state.plan.goal, watch), gaps);
      const followUps = [...(watch?.followUps ?? []), ...(answer.followUps ?? [])];
      return { answer: { ...answer, followUps, ...(watch?.sources.length ? { sources: watch.sources } : {}) }, state: { ...state, plan }, sources: watch?.sources, activity: watch?.queries.map((q) => `Asked Exa: ${q}`) };
    },

    get_plan: (_, { state }, ctx) => {
      if (state.plan) {
        const text = `Your plan: save **${eur(state.plan.monthlySaving)} a month** until ${longDate(state.plan.targetDate)} for ${state.plan.goal.name}.`;
        return { answer: { type: 'plan', text, plan: state.plan, followUps: ['Re-check my plan'] }, state };
      }
      return { answer: state.draft ? showGoal(state.draft, ctx) : NO_PLAN(), state };
    },

    ask_coach: (args, { state }) => {
      const id = need(optEnum(args, 'id', COACH_IDS), 'id');
      return { answer: coach.answerRoute({ intent: id in INTENTS.forecast ? 'forecast' : 'action', id }), state };
    },

    set_multibank: (args, { state }) => {
      const next = { ...state, multiBank: need(optBool(args, 'on'), 'on') };
      const intro = next.multiBank ? `Now including your account at ${external.bank}. ` : 'Now showing your S-Pankki accounts only. ';
      return { answer: basketsAnswer(context(next).cashflow, intro), state: next };
    }
  };

  return {
    specs: TOOL_SPECS,
    hasResearch: research !== null,
    context,
    /** Runs one tool. Throws a 400 for an unknown tool or bad arguments. */
    async run(call: ToolCall, session: Session): Promise<ToolOutcome> {
      const handler = Object.prototype.hasOwnProperty.call(handlers, call.name) ? handlers[call.name] : undefined;
      if (!handler) throw bad(`Unknown tool: ${call.name}`);
      return handler(call.args ?? {}, session, context(session.state));
    }
  };
}

export type TrainerTools = ReturnType<typeof createTrainerTools>;

// ---- Declarations Gemini sees ----

const num = (description: string) => ({ type: 'number', description });
const text = (description: string) => ({ type: 'string', description });
const bool = (description: string) => ({ type: 'boolean', description });
const choice = (values: readonly string[], description: string) => ({ type: 'string', enum: values, description });
const spec = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolSpec =>
  ({ name, description, parameters: { type: 'object', properties, required } });

export const TOOL_SPECS: ToolSpec[] = [
  spec('get_safe_to_spend', 'What the user can safely spend this week, with the step-by-step math.'),
  spec('get_baskets', "The user's monthly cash flow in the three baskets (mandatory & regular, mandatory & irregular, everyday), income and what is left."),
  spec('query_spending', 'Total the user spent on something in a period, e.g. taxis last month.', {
    search: text('What to look for: a payee, a category, or a group such as "taxi", "groceries", "eating out".'),
    period: choice(PERIODS, 'Default last_30_days.')
  }, ['search']),
  spec('get_spending_profile', 'What kind of spender the user is: share of income per basket, biggest everyday categories, recent trend.'),
  spec('reclassify', 'Move one payment line to another basket when the user corrects an assumption. Recalculates baskets and safe-to-spend.', {
    line_id: text('The id of the line, from the list in the system prompt.'),
    basket: choice([...LINE_BASKETS, 'one_off'], 'regular = mandatory & regular, irregular = mandatory & irregular, everyday, one_off = will not repeat.')
  }, ['line_id', 'basket']),
  spec('simulate_goal', 'Start exploring a purchase or goal: savings path, running costs afterwards, alternatives.', {
    kind: choice(['car', 'purchase'], 'car adds insurance, fuel, maintenance and tax after the purchase.'),
    name: text('Short name, e.g. "used car", "trip to Japan".'),
    price: num('Price in euros, only if the user gave one.'),
    months: num('Months until the purchase. "Next year" = 12.'),
    note: text("The user's circumstances and priorities in a few words, e.g. \"commutes 40 km a day, family of four\".")
  }, ['kind', 'name']),
  spec('confirm_brief', 'The user confirmed the brief. Runs the simulation. Call only after the user said the brief is right.'),
  spec('what_if', 'Change the current goal (or estimate a spending cut when there is no goal) and recalculate.', {
    name: text('New public product description such as used Toyota Yaris Hybrid, without personal data. Changing it requires the user to confirm a revised brief.'),
    add_months: num('Wait this many more months (negative = sooner).'),
    months: num('Set the months until the purchase.'),
    price: num('A different price in euros.'),
    cut_group: text("What to cut: a category from the user's everyday spending exactly as listed in the system prompt (e.g. 'Restaurants'), a group (dining, groceries, taxi, leisure, transport, shopping) or 'everyday' for all of it."),
    cut_pct: num('Percent to cut, default 20. 0 removes the cut.'),
    keep_spending: bool('true = drop all cuts and keep current everyday spending.'),
    loan: bool('true = finance what is missing with a loan, false = no loan.'),
    loan_amount: num('How much to borrow, in euros. Leave out to borrow only what saving cannot cover.'),
    loan_years: num('Loan length in years.'),
    loan_rate_pct: num('Yearly interest rate in percent.'),
    cost_id: choice(RUNNING_COST_IDS, 'A running cost the user corrects.'),
    cost_monthly: num('Its cost in euros a month.')
  }),
  spec('search_web', 'Search the web (Exa) for real prices, loan terms, insurance costs or Finnish and European averages. Returns passages with their URL.', {
    query: text('A specific query, e.g. "average used car price Finland 2026" or "Statistics Finland household food spending per month".')
  }, ['query']),
  spec('research_goal', 'Research the current goal on the web with Exa: current options and typical price, running costs beyond the price, loan conditions. Every figure comes with its source and is applied to the goal.'),
  spec('choose_option', 'Use the price of one of the options research_goal found.', { index: num('Position of the option in the list, starting at 0.') }, ['index']),
  spec('apply_benchmark', 'Use a figure found by search_web in the current goal or plan. Rejected unless the quote appears in that source.', {
    topic: choice(Object.keys(TOPICS), 'What the figure is.'),
    value: num('The number exactly as the source states it.'),
    unit: choice(['eur', 'eur_per_month', 'eur_per_year', 'percent'], 'eur for a price, percent for a rate.'),
    source_url: text('URL of the source, as returned by search_web.'),
    quote: text('The sentence from the source that contains the number, copied word for word.')
  }, ['topic', 'value', 'unit', 'source_url', 'quote']),
  spec('agree_plan', 'Save the current goal as the agreed plan. Only when the user says they agree.', {
    allow_recheck: bool('true if the user also allowed re-checking the plan later.')
  }),
  spec('set_recheck_permission', 'Allow or stop all monitoring of the plan at once.', { allow: bool('The permission.') }, ['allow']),
  spec('set_monitoring', 'Record what the user approved the trainer to keep an eye on for the plan.', {
    prices: bool('Prices of the goal.'), conditions: bool('Loan terms when the plan uses a loan.'), spending: bool("The user's own spending.")
  }),
  spec('choose_path', 'Apply the choice the user made after a re-check found a change.', {
    id: choice(['less', 'sooner', 'buffer', 'later'], 'less = contribute less, sooner = reach the goal sooner, buffer = keep a larger buffer, later = reach the goal later.')
  }, ['id']),
  spec('recheck_plan', "Re-evaluate the agreed plan against the user's current cash flow."),
  spec('get_plan', 'The agreed plan, or the goal being explored.'),
  spec('ask_coach', 'A ready-made scenario or help text.', { id: choice(COACH_IDS, Object.entries({ ...INTENTS.forecast, ...INTENTS.action }).map(([id, what]) => `${id}: ${what}`).join('; ')) }, ['id']),
  spec('set_multibank', 'Include or exclude accounts at other banks (PSD2) in every calculation.', { on: bool('true = include other banks.') }, ['on'])
];
