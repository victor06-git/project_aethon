// Guided car purchase (Helsinki): a few short questions with tap answers, then the trainer's
// brief. Used when the user names no price ("I want to buy a big car"); a message that already
// has a price ("a used Yaris Hybrid for €8,000") goes straight to the brief as before.
// Every step is one question; nothing is simulated until all four are answered:
//   1 car type → 2 price (bands that fit the user's leftover, or their own) → 3 parking zone
//   → 4 how to pay (save up / loan / half and half) → brief with the inline planner.
// After that the trainer takes over: confirm the brief, research with Exa, what-ifs, the plan.
// The state is read from the conversation itself, so the flow survives reloads.
import type { Answer, ChatPlanner, ChatTurn } from '../domain/types';
import type { ToolCall } from './ports';

const CAR = /(?:\bcar\b|\bauto\b|машин|авто|vehicle|ajoneuvo)/i;
const WANTS = /(?:\bwant\b|\bneed\b|\bbuy\b|\bafford\b|purchase|save (?:up )?for|\bget (?:a |an )?|куп|хочу|нужн|приобрест|hankkia|ostaa|haluan)/i;
const wantsCar = (t: string) => CAR.test(t) && WANTS.test(t);

const LOAN_YEARS = 4;
const RATE = 0.06;                 // yearly, until Exa finds the current rate on confirm
const INSURANCE = 60;              // € a month, the trainer's default running cost
// Typical used-car price bands in Finland, by type (assumptions, labelled as such in the UI;
// confirming the brief and researching with Exa replaces them with sourced prices).
const BANDS: Record<string, number[]> = {
  'petrol car': [6000, 10000, 15000],
  'hybrid car': [9000, 14000, 20000],
  'electric car': [12000, 18000, 26000],
  'used car': [6000, 10000, 15000]
};
const BUFFER = 0.1;                // share of the monthly leftover kept free for surprises
const TYPICAL_PARKING = 80;        // € a month, before the user picks a zone

export interface CarContext { free: number }           // what is left each month (cash flow)

const ZONES = [
  { chip: 'Kallio / central (~€60/mo resident)', label: 'Kallio / central', monthly: 60, re: /kallio|central|keskusta|каллио|центр/i },
  { chip: 'Other Helsinki (~€100/mo)', label: 'Other Helsinki', monthly: 100, re: /other helsinki|~€100\/mo/i },
  { chip: 'Espoo / Vantaa (~€80/mo)', label: 'Espoo / Vantaa', monthly: 80, re: /espoo|vantaa|эспоо|вантаа/i },
  { chip: 'No resident parking', label: 'No resident parking', monthly: 0, re: /no (resident )?parking|own (parking|garage)|без парковк/i }
];
const PAY = [
  { chip: 'Save up first', id: 'save' as const, re: /save up|saving first|копить|säästä/i },
  { chip: `Loan · ${LOAN_YEARS} years`, id: 'loan' as const, re: /^loan|loan · |кредит|laina/i },
  { chip: 'Half now, half loan', id: 'half' as const, re: /half|половин|puolet/i }
];
const OWN_PRICE = "I'll type my own price";

function carType(t: string): string | null {
  if (/(?:electric|\bev\b|электро|sähkö)/i.test(t)) return 'electric car';
  if (/(?:hybrid|гибрид|hybridi)/i.test(t)) return 'hybrid car';
  if (/(?:petrol|diesel|бензин|дизель|bensiini)/i.test(t)) return 'petrol car';
  if (/(?:not sure|не решил|не знаю|en tiedä)/i.test(t)) return 'used car';
  return null;
}
const isBig = (t: string) => /\b(big|large|family|suv|estate|7.?seat|van)\b|больш|семейн|iso\b/i.test(t);

function priceIn(t: string): number | null {
  const m = t.replace(/ /g, ' ').match(/(\d{1,3}(?:[ ,.]\d{3})+|\d{4,6})\s*(?:€|eur|euro)?|(\d{1,3})\s?k\b/i);
  if (!m) return null;
  const n = m[2] ? Number(m[2]) * 1000 : Number(m[1].replace(/[^\d]/g, ''));
  return n >= 1000 && n <= 200000 ? n : null;
}

const round500 = (n: number) => Math.max(1000, Math.round(n / 500) * 500);
const eur = (n: number) => `${n < 0 ? '−' : ''}€${Math.abs(Math.round(n)).toLocaleString('en-GB')}`;
const payment = (principal: number, months: number) => {
  const r = RATE / 12, f = (1 + r) ** months;
  return principal <= 0 ? 0 : (principal * r * f) / (f - 1);
};
const principalFor = (monthly: number, months: number) => {
  const r = RATE / 12;
  return (monthly * (1 - (1 + r) ** -months)) / r;
};

const ru = (t: string) => /[а-яё]/i.test(t);
const ask = (text: string, followUps: string[], extra: Partial<Answer> = {}): Answer => ({ type: 'chat', text, followUps, source: 'rules', ...extra });

export type CarStep =
  | { kind: 'ask'; answer: Answer }
  | { kind: 'start'; calls: ToolCall[]; planner?: ChatPlanner; text: string };

/** Decides the next step of the car flow, or null when the question is not part of it. */
export function carFlow(q: string, history: ChatTurn[], ctx: CarContext): CarStep | null {
  const turns = [...history, { role: 'user' as const, text: q }];
  // The flow starts at the last message that asked for a car.
  const startAt = turns.map((t) => t.role === 'user' && wantsCar(t.text)).lastIndexOf(true);
  if (startAt < 0) return null;
  // A price in the first message: the user knows what they want, so the brief comes straight away.
  if (priceIn(turns[startAt].text) !== null) return null;
  const users = turns.slice(startAt).filter((t) => t.role === 'user').map((t) => t.text);
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')?.text ?? '';
  const R = ru(users[0]);

  const typeAt = users.findIndex((t) => carType(t));
  const type = typeAt >= 0 ? carType(users[typeAt])! : null;
  const big = users.some(isBig);
  const name = type ? `${big ? 'big ' : ''}${type}` : null;
  const priceAt = users.findIndex((t, i) => i >= Math.max(0, typeAt) && priceIn(t) !== null);
  const price = priceAt >= 0 ? priceIn(users[priceAt]) : null;
  const zone = ZONES.find((z) => users.some((t) => z.re.test(t))) ?? null;
  const pay = PAY.find((p) => users.slice(1).some((t) => p.re.test(t))) ?? null;
  const current = users[users.length - 1];

  // Everything answered and this message is not one of the answers: the trainer takes over.
  const isAnswer = carType(current) || priceIn(current) !== null || ZONES.some((z) => z.re.test(current)) || PAY.some((p) => p.re.test(current)) || current === OWN_PRICE || wantsCar(current);
  if (!isAnswer) return null;

  if (!type) {
    return { kind: 'ask', answer: ask(R ? 'Хельсинки — какую машину планируем?' : 'Helsinki — which kind of car are we planning for?',
      // At most three taps (the chat shows three); "not sure" can be typed.
      R ? ['Электро', 'Гибрид', 'Бензин / Дизель'] : ['Electric', 'Hybrid', 'Petrol / Diesel']) };
  }

  if (!price) {
    if (current === OWN_PRICE || /type any price/i.test(lastAssistant)) {
      return { kind: 'ask', answer: ask(R ? 'Напишите цену в евро, например 9500.' : 'Type any price in euros, for example 9500.', []) };
    }
    // The loan payment may take what is left after insurance, typical parking and a buffer.
    const room = Math.max(0, ctx.free * (1 - BUFFER) - INSURANCE - TYPICAL_PARKING);
    const fits = Math.floor(principalFor(room, LOAN_YEARS * 12) / 500) * 500;
    const bands = BANDS[type].map((b) => round500(b * (big ? 1.25 : 1)));
    const rows = bands.map((b) => ({ label: eur(b), amount: Math.round(payment(b, LOAN_YEARS * 12)) }));
    const fitText = fits >= bands[0]
      ? (R ? `кредит на ${LOAN_YEARS} года без напряга покрывает примерно до **${eur(fits)}**` : `a ${LOAN_YEARS}-year loan fits up to about **${eur(fits)}**`)
      : (R ? `кредит пока не помещается — понадобятся накопления или первый взнос` : `a loan alone does not fit yet: plan on saving or a down payment`);
    const text = R
      ? `Типичные цены б/у ${name} в Финляндии (оценка). При остатке ~**${eur(ctx.free)}/мес** ${fitText}. Столбики — платёж в месяц. Выберите или напишите свою цену.`
      : `Typical prices for a used ${name} in Finland (estimates). With ~**${eur(ctx.free)}/mo** left over, ${fitText}. Bars: monthly loan payment. Pick one or type your own price.`;
    return { kind: 'ask', answer: ask(text, bands.map((b) => `~${eur(b)}`), { rows }) };
  }

  if (!zone) {
    return { kind: 'ask', answer: ask(R ? `**${eur(price)}** — где будете парковать? Резидентская парковка добавится к расходам.` : `**${eur(price)}**. Where will you park it? Resident parking adds to the monthly cost.`, ZONES.slice(0, 3).map((z) => z.chip)) };
  }

  if (!pay) {
    return { kind: 'ask', answer: ask(R ? 'Как платим?' : 'How do you want to pay for it?', PAY.map((p) => p.chip)) };
  }

  // All four answered, and this message completed the set: write the brief.
  const saveMonths = Math.min(60, Math.max(3, Math.ceil(price / Math.max(50, ctx.free * 0.8))));
  const months = pay.id === 'save' ? saveMonths : 12;
  const calls: ToolCall[] = [
    { name: 'simulate_goal', args: { kind: 'car', name: name!, price, months, note: `Helsinki, ${zone.label}` } },
    { name: 'what_if', args: { cost_id: 'parking', cost_monthly: zone.monthly } }
  ];
  if (pay.id !== 'save') calls.push({ name: 'what_if', args: { loan: true, loan_years: LOAN_YEARS, ...(pay.id === 'half' ? { loan_amount: Math.round(price / 2) } : {}) } });

  const down = pay.id === 'half' ? Math.round(price / 2) : 0;
  const loanMonthly = pay.id === 'save' ? 0 : payment(price - down, LOAN_YEARS * 12);
  const carMonthly = loanMonthly + zone.monthly + INSURANCE;
  const left = ctx.free - carMonthly;
  const how = pay.id === 'save' ? `saving ~${eur(price / months)}/mo for ${months} months` : pay.id === 'half' ? `${eur(down)} down + ${LOAN_YEARS}-year loan` : `${LOAN_YEARS}-year loan`;
  const text = pay.id === 'save'
    ? `**${name} · ${eur(price)}** by ${how}. After buying, parking and insurance are ~**${eur(zone.monthly + INSURANCE)}/mo**. Confirm the brief to see the full plan.`
    : left >= 0
      ? `**${name} · ${eur(price)}** with a ${how}: ~**${eur(carMonthly)}/mo** with parking and insurance, leaving **${eur(left)}/mo**. Confirm the brief to see the full plan.`
      : `**${name} · ${eur(price)}** with a ${how}: ~**${eur(carMonthly)}/mo** with parking and insurance, **${eur(-left)}/mo more** than you have left. Try a down payment below, or confirm to see ways to close the gap.`;
  const planner: ChatPlanner | undefined = pay.id === 'save' ? undefined : {
    kind: 'car_helsinki', price, months: LOAN_YEARS * 12, rateAnnual: RATE, parkingMonth: zone.monthly,
    insuranceMonth: INSURANCE, leftoverMonth: Math.round(ctx.free), downPayment: down, zoneLabel: zone.label
  };
  return { kind: 'start', calls, planner, text };
}
