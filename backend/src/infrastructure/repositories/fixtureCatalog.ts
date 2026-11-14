// Catalog adapter: bank products and content from hand-made fixtures.
// Not personal money data, so it stays static until the bank's own APIs replace it.
import bank from '../fixtures/bank.json';
import profile from '../fixtures/profile.json';
import cards from '../fixtures/cards.json';
import loans from '../fixtures/loans.json';
import investments from '../fixtures/investments.json';
import purchases from '../fixtures/purchases.json';
import receipts from '../fixtures/receipts.json';
import offers from '../fixtures/offers.json';
import stores from '../fixtures/stores.json';
import bonus from '../fixtures/bonus.json';
import upcoming from '../fixtures/upcoming.json';
import recurring from '../fixtures/recurring.json';
import messages from '../fixtures/messages.json';
import type { Catalog } from '../../application/ports';

export function createFixtureCatalog(): Catalog {
  return {
    bank: () => bank, profile: () => profile, cards: () => cards, loans: () => loans,
    investments: () => investments, purchases: () => purchases, receipts: () => receipts,
    offers: () => offers, stores: () => stores, bonus: () => bonus, upcoming: () => upcoming,
    recurring: () => recurring, messages: () => messages
  };
}
