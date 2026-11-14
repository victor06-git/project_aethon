// Composition root: the only place that picks implementations for the ports.
// Shared by the Node server and the standalone (in-browser) build, so it must not
// import Node-only modules. Node-only adapters (CSV dataset, model) are passed in.
import { assertPort, type ForecastEngine, type QuestionClassifier, type TransactionRepository } from './application/ports';
import type { Answer } from './domain/types';
import { createBankService } from './application/bankService';
import { createCoachService } from './application/coachService';
import { createFixtureCatalog } from './infrastructure/repositories/fixtureCatalog';
import { createFixtureTransactions } from './infrastructure/repositories/fixtureTransactions';
import { createScenarioEngine } from './infrastructure/engine/scenarioEngine';
import { createRulesClassifier } from './infrastructure/classifiers/rulesClassifier';
import { createRouter } from './interfaces/http/router';

export interface ContainerDeps {
  transactions?: TransactionRepository | null;  // default: demo fixtures
  model?: QuestionClassifier | null;            // default: none, rules only
  kaiku?: { ask(question: string): Promise<Answer> } | null;  // full Python coach (Node server only)
  engine?: ForecastEngine;                      // default: hand-set scenarios
  log?: (msg: string) => void;
}

export function createContainer({ transactions, model = null, kaiku = null, engine, log = () => {} }: ContainerDeps = {}) {
  const tx = assertPort('TransactionRepository', transactions ?? createFixtureTransactions());
  const eng = assertPort('ForecastEngine', engine ?? createScenarioEngine());
  if (model) assertPort('QuestionClassifier', model);

  const bank = createBankService({ catalog: createFixtureCatalog(), transactions: tx });
  const coach = createCoachService({ engine: eng, transactions: tx, rules: createRulesClassifier(), model, kaiku, log });
  const router = createRouter({ bank, coach });
  return { bank, coach, handle: router.handle };
}

export type Container = ReturnType<typeof createContainer>;
