// Banking use cases. Shapes data for the screens; knows nothing about HTTP or storage.
// Personal money data comes from the TransactionRepository port; products from the Catalog.
import { round2 } from '../domain/money';
import { httpError } from '../domain/types';
import type { Catalog, TransactionRepository } from './ports';

export function createBankService({ catalog, transactions }: { catalog: Catalog; transactions: TransactionRepository }) {
  const accounts = () => transactions.accounts();
  const totalBalance = () => round2(accounts().reduce((s, a) => s + a.balance, 0));
  const recent = (n: number) => transactions.list().slice(0, n);

  return {
    bank: () => {
      const b = catalog.bank();
      return { name: b.name, shortName: b.shortName, rewardsName: b.rewardsName, currency: b.currency };
    },
    profile: () => catalog.profile(),
    dataSource: () => ({ source: transactions.source, customerId: transactions.customerId ?? null, asOf: transactions.asOf() }),
    home: () => {
      const bonus = catalog.bonus();
      return {
        firstName: catalog.profile().firstName,
        totalBalance: totalBalance(),
        invested: transactions.invested(),
        bonus: { earned: bonus.earned, progress: bonus.progress, nextTierGap: bonus.nextTierGap },
        upcomingCount: catalog.upcoming().length,
        recent: recent(5),
        asOf: transactions.asOf()
      };
    },
    accounts: () => ({ accounts: accounts(), totalBalance: totalBalance(), invested: transactions.invested() }),
    account: (id: string) => {
      const acc = accounts().find((a) => a.id === id) ?? (id === 'current' ? accounts()[0] : undefined);
      if (!acc) throw httpError(404, 'Account not found');
      const list = transactions.list();
      return { ...acc, transactions: (transactions.source === 'csv' ? list.filter((t) => t.account === acc.id) : list).slice(0, 6) };
    },
    transactions: (limit?: string | number) => recent(Math.min(500, Number(limit) || 50)),
    cards: () => catalog.cards(),
    loans: () => catalog.loans(),
    mortgage: () => catalog.loans().loans.find((l) => l.id === 'mortgage') ?? null,
    investments: () => {
      const inv = catalog.investments();
      const value = transactions.invested();
      if (!value) return inv;
      // One fund holds what the account history says was invested.
      return { ...inv, value, funds: inv.funds.slice(0, 1).map((f) => ({ ...f, value })) };
    },
    purchases: () => catalog.purchases(),
    receipts: () => catalog.receipts(),
    receipt: (id: string) => {
      const r = catalog.receipts().find((x) => x.id === id);
      if (!r) throw httpError(404, 'Receipt not found');
      return r;
    },
    offers: () => catalog.offers(),
    stores: () => catalog.stores(),
    bonus: () => catalog.bonus(),
    upcoming: () => catalog.upcoming(),
    recurring: () => catalog.recurring(),
    messages: () => catalog.messages(),
    createPayment: (body: { amount?: unknown } | undefined) => {
      if (!(Number(body?.amount) > 0)) throw httpError(400, 'Enter an amount greater than zero');
      return { status: 'not_sent', note: 'Demo only: no payment was made and no money was debited.' };
    },
    createTransfer: () => ({ status: 'not_sent', note: 'Demo only: no transfer was made.' })
  };
}

export type BankService = ReturnType<typeof createBankService>;
