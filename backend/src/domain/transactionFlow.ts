import type { Transaction } from './types';

type Flow = 'spending' | 'refund' | 'income' | 'saving' | 'scheduled_transfer' | 'internal_transfer';

/** A salary sweep leaves the observed account. The export does not identify its destination. */
export function transactionFlow(t: Transaction): Flow {
  if (t.type === 'salary_sweep') return 'scheduled_transfer';
  if (t.type === 'internal_transfer') return 'internal_transfer';
  if (t.type === 'investment_deposit' || t.type === 'investment_withdrawal' || /^invest/i.test(t.category)) return 'saving';
  if (t.amount < 0) return 'spending';
  if (t.amount > 0 && (t.type === 'refund' || t.type === 'purchase_refund' || t.type === 'purchase')) return 'refund';
  return 'income';
}

export function countsTowardSpending(t: Transaction): boolean {
  const flow = transactionFlow(t);
  return flow === 'spending' || flow === 'refund';
}
