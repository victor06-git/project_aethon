// Screen registry. Revi screens are merged in only in Revi mode (they replace Invest).
import type { ComponentType } from 'react';
import { HomeScreen } from './bank/Home';
import { BankingScreen, MeScreen, PayScreen, RewardsScreen } from './bank/Tabs';
import { AccountScreen, AccountsScreen, CardScreen, CardsScreen, SecurityScreen, TransactionsScreen } from './bank/Accounts';
import { InvestBankScreen, LoansScreen, MortgageScreen, SaverScreen } from './bank/Money';
import { OffersScreen, PurchasesScreen, ReceiptScreen, ReceiptsScreen, StoresScreen } from './bank/Shopping';
import {
  AuthScreen, EinvoicesScreen, HelpScreen, MessagesScreen, NewPaymentScreen, PayslipScreen, PrivateScreen,
  ProfileScreen, SearchScreen, SettingsScreen, TransferScreen, UpcomingScreen, VirtualAssistantScreen
} from './bank/Services';
import { CityScreen, ExpensesScreen, RecurringScreen } from '../revi/ReviScreens';
import { InvestScreen } from '../revi/invest/InvestScreen';
import { StockScreen } from '../revi/invest/StockScreen';
import { CashflowScreen, PlanScreen } from '../revi/TrainerScreens';

export interface ScreenDef { title: string; Component: ComponentType<{ arg: string | null }> }

const bank: Record<string, ScreenDef> = {
  home: { title: 'Home', Component: HomeScreen },
  rewards: { title: 'S-Etukortti', Component: RewardsScreen },
  pay: { title: 'Pay', Component: PayScreen },
  banking: { title: 'Banking', Component: BankingScreen },
  me: { title: 'Me', Component: MeScreen },
  accounts: { title: 'Accounts', Component: AccountsScreen },
  account: { title: 'Account', Component: AccountScreen },
  transactions: { title: 'Transactions', Component: TransactionsScreen },
  cards: { title: 'Cards', Component: CardsScreen },
  card: { title: 'Card', Component: CardScreen },
  security: { title: 'Card limits', Component: SecurityScreen },
  loans: { title: 'Loans', Component: LoansScreen },
  mortgage: { title: 'Mortgage', Component: MortgageScreen },
  invest: { title: 'Invest', Component: InvestBankScreen },
  saver: { title: 'Saver', Component: SaverScreen },
  purchases: { title: 'My purchases', Component: PurchasesScreen },
  receipts: { title: 'Receipts', Component: ReceiptsScreen },
  receipt: { title: 'Receipt', Component: ReceiptScreen },
  offers: { title: 'Offers and tips', Component: OffersScreen },
  stores: { title: 'Where to earn rewards', Component: StoresScreen },
  auth: { title: 'Authentication', Component: AuthScreen },
  messages: { title: 'Messages', Component: MessagesScreen },
  assistant: { title: 'Virtual assistant', Component: VirtualAssistantScreen },
  profile: { title: 'Personal details', Component: ProfileScreen },
  settings: { title: 'Settings', Component: SettingsScreen },
  help: { title: 'Customer service', Component: HelpScreen },
  payslip: { title: 'Online payslip', Component: PayslipScreen },
  private: { title: 'Private banking', Component: PrivateScreen },
  search: { title: 'Search', Component: SearchScreen },
  newpayment: { title: 'New payment', Component: NewPaymentScreen },
  transfer: { title: 'Own transfer', Component: TransferScreen },
  upcoming: { title: 'Upcoming payments', Component: UpcomingScreen },
  einvoices: { title: 'E-invoices', Component: EinvoicesScreen }
};

const revi: Record<string, ScreenDef> = {
  invest: { title: 'Invest', Component: InvestScreen },
  stock: { title: 'Invest', Component: StockScreen },
  city: { title: '3D Financial City', Component: CityScreen },
  expenses: { title: 'Necessary expenses', Component: ExpensesScreen },
  recurring: { title: 'Recurring expenses', Component: RecurringScreen },
  cashflow: { title: 'Three baskets', Component: CashflowScreen },
  plan: { title: 'Your plan', Component: PlanScreen }
};

export const screensFor = (withRevi: boolean): Record<string, ScreenDef> => (withRevi ? { ...bank, ...revi } : bank);
