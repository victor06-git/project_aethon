// Me-side services, messages, search, and payments.
import type { FormEvent } from 'react';
import { useData, useModel } from '../../../models/hooks';
import { useNav } from '../../../controllers/nav';
import { money, shortDate } from '../../format';
import { Btn, Card, Field, List, Loading, Row } from '../../components';
import { fullDate } from '../../revi/TrainerCards';

export const AuthScreen = () => (
  <div className="content">
    <div className="two">
      <Btn label="Scan QR code" modal={['Scan QR code', 'The camera is not available in this browser prototype.']} />
      <Btn label="Approve action" modal={['Approve action', 'No actions are waiting for confirmation.']} />
    </div>
    <p className="foot">Authentication does not connect to a bank in this demo.</p>
  </div>
);

export function MessagesScreen() {
  const m = useData<any[]>('/api/messages');
  if (!m || !Array.isArray(m)) return <Loading />;
  return (
    <div className="content"><List>
      <Row icon="message" title="Virtual assistant" sub="Common questions" go="assistant" />
      {m.map((x) => <Row key={x.subject} title={x.subject} sub={`${x.from} · ${shortDate(x.date)}`} />)}
    </List></div>
  );
}

export const VirtualAssistantScreen = () => (
  <div className="content"><div className="card padded"><div className="rtitle">Hi! How can I help?</div>
    {['Card limits', 'Account balance', 'Payments'].map((q) => <Btn key={q} label={q} modal={['Virtual assistant', `Demo answer about: ${q}.`]} />)}
  </div></div>
);

export function ProfileScreen() {
  const p = useData<any>('/api/profile');
  if (!p) return <Loading />;
  return (
    <div className="content"><List>
      <Row title="Name" value={p.fullName} /><Row title="Email" value={p.email} />
      <Row title="Phone" value={p.phone} /><Row title="Membership" value={p.membership} />
    </List></div>
  );
}

export const SettingsScreen = () => (
  <div className="content">
    <Field label="Language" name="lang" options={['English', 'Finnish', 'Swedish']} />
    <List><Row title="Notifications" sub="Manage notifications" /><Row title="Security" sub="Sign-in and PIN" go="auth" /></List>
  </div>
);

export const HelpScreen = () => (
  <div className="content">
    <List><Row title="Frequently asked questions" sub="Help articles" /><Row title="Contact us" sub="Bank customer service" /></List>
    <p className="small">This demo cannot send messages to the bank.</p>
  </div>
);

export const PayslipScreen = () => <div className="content"><div className="card padded">No sample payslips available.</div></div>;
export const PrivateScreen = () => <div className="content"><div className="card padded">Wealth management for eligible customers.</div></div>;

// Search over the app's own sections: a navigation feature, so it lives in the UI.
const SEARCHABLE = [
  { screen: 'accounts', title: 'Accounts', icon: 'accounts' }, { screen: 'pay', title: 'Payments', icon: 'pay' },
  { screen: 'cards', title: 'Cards', icon: 'card' }, { screen: 'loans', title: 'Loans', icon: 'loan' },
  { screen: 'invest', title: 'Investments', icon: 'invest' }, { screen: 'purchases', title: 'My purchases', icon: 'bag' },
  { screen: 'receipts', title: 'Receipts', icon: 'receipt' }, { screen: 'messages', title: 'Messages', icon: 'message' },
  { screen: 'settings', title: 'Settings', icon: 'settings' }
];

export function SearchScreen({ arg }: { arg: string | null }) {
  const nav = useNav();
  const q = (arg ?? '').toLowerCase();
  const hits = SEARCHABLE.filter((x) => x.title.toLowerCase().includes(q));
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); nav.setArg(String(new FormData(e.currentTarget).get('q') ?? '')); };
  return (
    <div className="content">
      <form onSubmit={submit}><Field label="Search services" name="q" defaultValue={arg ?? ''} /></form>
      {hits.length ? <List>{hits.map((r) => <Row key={r.screen} icon={r.icon} title={r.title} go={r.screen} />)}</List> : <p className="foot">No results</p>}
    </div>
  );
}

function useDemoSubmit(path: string, title: string) {
  const model = useModel();
  const nav = useNav();
  return async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const res = await model.post<{ note: string }>(path, Object.fromEntries(new FormData(e.currentTarget).entries()));
      nav.showModal(title, res.note);
    } catch (err) {
      nav.showModal('Could not submit', (err as Error).message);
    }
  };
}

export function NewPaymentScreen() {
  const submit = useDemoSubmit('/api/payments', 'Payment');
  return (
    <div className="content"><form onSubmit={submit}>
      <Field label="From account" name="from" options={['Current account · €812.34']} />
      <Field label="Recipient name" name="payee" />
      <Field label="Account number (IBAN)" name="iban" />
      <Field label="Amount" name="amount" type="number" />
      <Field label="Message or reference" name="message" />
      <div className="warn">Demo only. Payment instructions are not sent anywhere.</div>
      <Btn label="Continue" primary block submit />
    </form></div>
  );
}

export function TransferScreen({ arg }: { arg: string | null }) {
  const submit = useDemoSubmit('/api/transfers', 'Confirmation');
  const model = useModel();
  const nav = useNav();
  const plan = arg === 'savings-plan' ? model.trainer.plan : null;
  if (plan) {
    return (
      <div className="content">
        <h1 className="title">Savings transfer preview</h1>
        <Card padded>
          <dl className="t-transfer">
            <div><dt>Goal</dt><dd>{plan.goal.name}</dd></div>
            <div><dt>Amount</dt><dd>{money(plan.monthlySaving)}</dd></div>
            <div><dt>From</dt><dd>Current account</dd></div>
            <div><dt>To</dt><dd>Savings account</dd></div>
            <div><dt>Frequency</dt><dd>Monthly</dd></div>
            <div><dt>Save until</dt><dd>{fullDate(plan.targetDate)}</dd></div>
          </dl>
        </Card>
        <div className="warn">Simulation. Review how the transfer would look in S-mobiili.</div>
        <Btn label="Confirm simulation" primary block onClick={() => nav.showModal('Simulation complete', 'Your savings plan is still saved on this device. No payment was scheduled or made.')} />
      </div>
    );
  }
  return (
    <div className="content"><form onSubmit={submit}>
      <Field label="From account" name="from" options={['Current account · €812.34', 'Savings account · €3,400.00']} />
      <Field label="To account" name="to" options={['Savings account · €3,400.00', 'Current account · €812.34']} />
      <Field label="Amount" name="amount" type="number" />
      <Btn label="Transfer" primary block submit />
    </form></div>
  );
}

export function UpcomingScreen() {
  const u = useData<any[]>('/api/payments/upcoming');
  if (!u || !Array.isArray(u)) return <Loading />;
  return (
    <div className="content">
      <List>{u.map((x) => <Row key={x.name} title={x.name} sub={shortDate(x.date)} value={money(x.amount)} />)}</List>
      <Btn label="New payment" go="newpayment" primary block />
    </div>
  );
}

export const EinvoicesScreen = () => (
  <div className="content">
    <List><Row title="Electricity company" sub="Active e-invoice agreement" /><Row title="Phone operator" sub="Active e-invoice agreement" /></List>
    <Btn label="Request new e-invoice" block modal={['New e-invoice', 'New e-invoice agreements cannot be created in this demo.']} />
  </div>
);
