// Personal Economic Trainer use cases: cash flow, the conversation and direct actions.
//   conversation → Gemini calls tools (function calling) → answer text checked against tool results
//   no model, or the model fails → keyword rules call one tool → the text the tool computed
// The API is stateless: the client sends the trainer state and gets the new state back.
import { httpError, type Answer, type ChatTurn } from '../domain/types';
import { parseState } from '../domain/trainerState';
import { BASKETS, TRAINER_DISCLAIMER, eur, type Cashflow, type Source, type TrainerReply, type TrainerState } from '../domain/trainer';
import { ungroundedFigures } from './grounding';
import { ruleCall } from './trainerRules';
import { allLines, type ToolOutcome, type TrainerTools } from './trainerTools';
import type { AgentModel, QuestionClassifier, ToolCall } from './ports';

const MAX_MESSAGES = 60;
const MAX_TURNS = 12;               // what the model sees of the conversation
const MAX_QUESTION = 500;
const MAX_REPLY = 2000;
const MAX_STEPS = 6;

export const STARTERS = [
  'What can I safely spend this week?', 'Where did my money go?', 'Could I buy a car next year?', 'What kind of spender am I?'
];

interface Deps {
  tools: TrainerTools;
  rules: QuestionClassifier;
  agent?: AgentModel | null;
  source: () => string;
  log?: (msg: string) => void;
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isHttpError = (err: unknown): err is { status: number; message: string } => isObject(err) && typeof err.status === 'number';
const message = (err: unknown) => (err instanceof Error ? err.message : isHttpError(err) ? err.message : String(err));

/** Validates the conversation: user and assistant turns, the last one from the user. */
function parseTurns(input: unknown): ChatTurn[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_MESSAGES) throw httpError(400, 'messages must be a non-empty list');
  const turns: ChatTurn[] = [];
  for (const item of input) {
    if (!isObject(item) || (item.role !== 'user' && item.role !== 'assistant') || typeof item.text !== 'string' || !item.text.trim()) {
      throw httpError(400, 'Each message needs a role (user or assistant) and a text');
    }
    if (item.role === 'user' && item.text.length > MAX_QUESTION) throw httpError(400, 'Question is too long');
    const text = item.text.trim().slice(0, MAX_REPLY);
    const last = turns[turns.length - 1];
    // Two messages in a row from the same side (after a failed request) become one turn.
    if (last?.role === item.role) turns[turns.length - 1] = { role: last.role, text: `${last.text}\n${text}` };
    else turns.push({ role: item.role, text });
  }
  if (turns[turns.length - 1].role !== 'user') throw httpError(400, 'The last message must be from the user');
  const recent = turns.slice(-MAX_TURNS);
  return recent[0].role === 'user' ? recent : recent.slice(1);
}

function systemPrompt(cashflow: Cashflow, state: TrainerState): string {
  const lines = allLines(cashflow).map((l) => `${l.id} | ${l.label} | ${l.basket} | ${eur(l.monthly)}/month | last ${eur(l.lastAmount)} on ${l.lastDate}${l.basis === 'assumed' ? ' | ASSUMED' : ''}`);
  const goal = state.draft
    ? `Goal being explored: ${state.draft.name}, ${eur(state.draft.price)}, in ${state.draft.months} months (brief ${state.draft.confirmed ? 'confirmed' : 'NOT yet confirmed'}).`
    : 'No goal is being explored.';
  const plan = state.plan ? `Agreed plan: ${state.plan.goal.name}, ${eur(state.plan.monthlySaving)} a month until ${state.plan.targetDate}.` : 'No agreed plan.';
  return [
    "You are Revi, the personal economic trainer inside S-Pankki's S-mobiili app. You help people understand their own money and learn through decisions.",
    'Rules:',
    "- Get every figure about the user's money, a goal, a plan or prices from a tool. Never calculate, estimate or guess a number yourself: only repeat figures a tool returned.",
    `- The three baskets are: ${BASKETS.map((b) => `${b.basket} = ${b.label}`).join('; ')}.`,
    '- When the user corrects an assumption ("that was a one-off", "that was a repair"), call reclassify with the matching line id, then say what changed.',
    '- For a purchase or goal call simulate_goal: it returns a brief. Show the brief and wait. Only when the user confirms it call confirm_brief, which runs the numbers.',
    '- Use what_if for every change the user asks for. Show the tradeoffs; do not just say yes or no.',
    '- After a plan is agreed, ask what to keep an eye on (set_monitoring). When a re-check offers choices, explain them and call choose_path with the one the user picks.',
    '- To research a goal (current options, the costs beyond the price, loan conditions) call research_goal: it returns figures with their sources and applies them. Name the source sites.',
    '- For any other question about the outside world (averages, rules, prices) call search_web and answer from the passages it returns, naming the source. To use such a figure in the goal call apply_benchmark with the exact quote.',
    '- Explain in plain, encouraging language for someone new to finance: why the numbers look the way they do and one next step. At most 110 words.',
    '- Format: short paragraphs, "- " bullets, **bold** for key figures. No headings, tables or links.',
    '- General guidance, not individual investment advice. The user decides.',
    "- Reply in the language of the user's last message.",
    `Today is ${cashflow.asOf}. ${goal} ${plan}`,
    'Payment lines (id | payee | basket | cost | last payment):',
    ...lines
  ].join('\n');
}

const clarify = (): Answer => ({
  type: 'clarify', source: 'rules', examples: STARTERS,
  text: 'I can help with your cash flow, a purchase you are thinking about, or your agreed plan. Try one of these:'
});

export function createTrainerService({ tools, rules, agent = null, source, log = () => {} }: Deps) {
  /** One request: tools change the state and collect cards; the last word is text. */
  function conversation(initial: TrainerState, turns: ChatTurn[]) {
    let state = initial;
    let sources: Source[] = [];
    const outcomes: ToolOutcome[] = [];

    async function execute(call: ToolCall): Promise<ToolOutcome> {
      const outcome = await tools.run(call, { state, sources });
      state = outcome.state;
      sources = [...sources, ...(outcome.sources ?? [])];
      outcomes.push(outcome);
      return outcome;
    }

    /** What the model sees of a tool call. Bad arguments come back as an error it can fix. */
    async function executeForModel(call: ToolCall): Promise<unknown> {
      try {
        const { followUps: _chips, ...seen } = (await execute(call)).answer;
        return seen;
      } catch (err) {
        if (isHttpError(err)) return { error: err.message };
        throw err;
      }
    }

    /** The reply: cards from every tool that ran, and the model's text only if its figures check out. */
    function reply(modelText: string | null): TrainerReply {
      const cards: Answer = Object.assign({}, ...outcomes.map((o) => o.answer));
      const computed = outcomes[outcomes.length - 1].answer.text;
      const evidence = [outcomes.map((o) => o.answer), turns.map((t) => t.text)];
      const invented = modelText ? ungroundedFigures(modelText, evidence) : [];
      if (invented.length) log(`model figures not in the tool results (${invented.join(', ')}): using the computed text`);
      const useModel = modelText !== null && !invented.length;
      const answer: Answer = {
        ...cards, text: useModel ? modelText : computed, source: useModel ? 'model' : 'rules',
        ...(sources.length ? { sources } : {})
      };
      return { answer, state };
    }

    return { execute, executeForModel, reply, ran: () => outcomes.length > 0, state: () => state };
  }

  async function byRules(talk: ReturnType<typeof conversation>, question: string): Promise<TrainerReply> {
    const state = talk.state();
    const { cashflow } = tools.context(state);
    const call = await ruleCall(question, {
      lines: allLines(cashflow), goal: state.draft ?? state.plan?.goal ?? null, hasPlan: state.plan !== null,
      pendingBrief: state.draft !== null && !state.draft.confirmed, year: cashflow.asOf.slice(0, 4)
    }, rules);
    if (!call) return { answer: clarify(), state };
    await talk.execute(call);
    return talk.reply(null);
  }

  return {
    /** The three baskets, safe-to-spend and safe-to-save for this state. */
    cashflow(body: unknown): Cashflow & { disclaimer: string } {
      const state = parseState(isObject(body) ? body.state : undefined);
      return { ...tools.context(state).cashflow, disclaimer: TRAINER_DISCLAIMER };
    },

    /** The conversation. Body: { messages: [{ role, text }], state }. */
    async chat(body: unknown): Promise<TrainerReply> {
      if (!isObject(body)) throw httpError(400, 'Request body must be an object');
      const turns = parseTurns(body.messages);
      const talk = conversation(parseState(body.state), turns);
      const question = turns[turns.length - 1].text;
      if (!agent) return byRules(talk, question);
      try {
        const context = tools.context(talk.state());
        const text = await agent.run({ system: systemPrompt(context.cashflow, talk.state()), turns, tools: tools.specs, execute: talk.executeForModel, maxSteps: MAX_STEPS });
        if (talk.ran()) return talk.reply(text);
        // No tool was called: fine for explaining a concept, not for figures about the user.
        const invented = ungroundedFigures(text, turns.map((t) => t.text));
        if (!invented.length) return { answer: { type: 'chat', text, source: 'model' }, state: talk.state() };
        log(`model answered with figures but no tool (${invented.join(', ')}): using the rules`);
      } catch (err) {
        log(`agent failed, using the rules: ${message(err)}`);
        if (talk.ran()) return talk.reply(null);
      }
      return byRules(talk, question);
    },

    /** One tool, called directly by a button, a toggle or a slider. Body: { action: { name, args }, state }. */
    async action(body: unknown): Promise<TrainerReply> {
      if (!isObject(body) || !isObject(body.action) || typeof body.action.name !== 'string') throw httpError(400, 'action must have a name');
      const args = body.action.args === undefined ? {} : body.action.args;
      if (!isObject(args)) throw httpError(400, 'action.args must be an object');
      const talk = conversation(parseState(body.state), []);
      await talk.execute({ name: body.action.name, args });
      return talk.reply(null);
    },

    status: () => ({ model: agent !== null, research: tools.hasResearch, data: source(), starters: STARTERS })
  };
}

export type TrainerService = ReturnType<typeof createTrainerService>;
