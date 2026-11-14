// TransactionRepository adapter over the hand-made demo fixtures.
// Used by the standalone HTML file and whenever the bank dataset is not available.
import accountsData from '../fixtures/accounts.json';
import txData from '../fixtures/transactions.json';
import { FIXTURE_LABEL } from '../../domain/categories';
import type { Transaction } from '../../domain/types';
import type { TransactionRepository } from '../../application/ports';

export function createFixtureTransactions(): TransactionRepository {
  const list: Transaction[] = txData
    .map((t) => ({
      id: t.id, date: t.date, merchant: t.merchant,
      category: FIXTURE_LABEL[t.category] ?? t.category, coachKey: t.category, amount: t.amount
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    source: 'fixture',
    asOf: () => list[0].date,
    accounts: () => accountsData.accounts,
    invested: () => accountsData.invested,
    list: () => list
  };
}
