// ExternalAccounts adapter: one demo account at another bank, as PSD2 account information
// would deliver it. Dates are relative to the data set's "today", so it fits any data source.
// A real PSD2 (account information) connection replaces this file and keeps the same methods.
import { addDays } from '../../domain/dates';
import { FIXTURE_LABEL } from '../../domain/categories';
import type { Account } from '../../domain/types';
import type { ExternalAccounts } from '../../application/ports';

const BANK = 'Other bank (PSD2 demo)';
const ACCOUNT: Account = { id: 'ext-current', name: 'Everyday account', iban: 'FI•• •••• •••• 4471', balance: 438.6, kind: 'current', bank: BANK };

type Row = [daysAgo: number, merchant: string, category: string, amount: number];
const repeat = (days: number[], merchant: string, category: string, amount: number): Row[] => days.map((d) => [d, merchant, category, amount]);

const ROWS: Row[] = [
  ...repeat([5, 35, 66], 'Spotify', 'subscriptions', -11.99),
  ...repeat([12, 43, 73], 'Side job', 'salary', 180),
  ...repeat([1, 3, 8, 10, 15, 17, 22, 29, 36, 45, 52], 'Kahvila Aamu', 'restaurants', -4.2),
  ...repeat([2, 9, 16, 23, 30, 44, 58], 'Lounas Bistro', 'restaurants', -11.5),
  [20, 'Apteekki', 'health', -23.4]
];

export function createFixtureExternal(): ExternalAccounts {
  return {
    bank: BANK,
    accounts: () => [ACCOUNT],
    transactions: (asOf) => ROWS.map(([daysAgo, merchant, category, amount], i) => ({
      id: `ext-${i}`, date: addDays(asOf, -daysAgo), merchant,
      category: FIXTURE_LABEL[category] ?? category, coachKey: category, amount, account: ACCOUNT.id
    }))
  };
}
