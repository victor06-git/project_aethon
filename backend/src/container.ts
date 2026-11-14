// Composition root: the only place that picks implementations for the ports.
// Shared by the Node server and the standalone (in-browser) build, so it must not
// import Node-only modules. Node-only adapters (CSV dataset, models, web research) are passed in.
import {
  assertPort, type AgentModel, type ExternalAccounts, type ForecastEngine, type QuestionClassifier, type ResearchProvider, type TransactionRepository
} from './application/ports';
import { createBankService } from './application/bankService';
import { createCoachService } from './application/coachService';
import { createTrainerTools } from './application/trainerTools';
import { createTrainerService } from './application/trainerService';
import { createFixtureCatalog } from './infrastructure/repositories/fixtureCatalog';
import { createFixtureTransactions } from './infrastructure/repositories/fixtureTransactions';
import { createFixtureExternal } from './infrastructure/repositories/fixtureExternal';
import { createScenarioEngine } from './infrastructure/engine/scenarioEngine';
import { createRulesClassifier } from './infrastructure/classifiers/rulesClassifier';
import { createRouter } from './interfaces/http/router';

export interface ContainerDeps {
  transactions?: TransactionRepository | null;  // default: demo fixtures
  external?: ExternalAccounts;                  // default: one demo account at another bank (PSD2)
  model?: QuestionClassifier | null;            // default: none, rules only
  agent?: AgentModel | null;                    // default: none, the trainer answers by rules
  research?: ResearchProvider | null;           // default: none, the trainer keeps its assumptions
  engine?: ForecastEngine;                      // default: hand-set scenarios
  log?: (msg: string) => void;
}

export function createContainer({ transactions, external, model = null, agent = null, research = null, engine, log = () => {} }: ContainerDeps = {}) {
  const tx = assertPort('TransactionRepository', transactions ?? createFixtureTransactions());
  const ext = assertPort('ExternalAccounts', external ?? createFixtureExternal());
  const eng = assertPort('ForecastEngine', engine ?? createScenarioEngine());
  if (model) assertPort('QuestionClassifier', model);
  if (agent) assertPort('AgentModel', agent);
  if (research) assertPort('ResearchProvider', research);

  const rules = createRulesClassifier();
  const bank = createBankService({ catalog: createFixtureCatalog(), transactions: tx });
  const coach = createCoachService({ engine: eng, transactions: tx, rules, model, log });
  const tools = createTrainerTools({ transactions: tx, external: ext, coach, research, log });
  const trainer = createTrainerService({ tools, rules, agent, source: () => tx.source, log });
  const router = createRouter({ bank, coach, trainer });
  return { bank, coach, trainer, handle: router.handle };
}

export type Container = ReturnType<typeof createContainer>;
