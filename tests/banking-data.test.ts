import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createContainer } from '../backend/src/container';
import { loadEncodedCsvTransactions } from '../backend/src/infrastructure/repositories/csvTransactions';

const csv = `\uFEFFcustomer_id,bank_account_id,tx_date,tx_timestamp,category,tx_amount_eur,balance_after_eur,transaction_type,merchant_id,mcc_code
CUST00001,ACC000001,2026-02-25,25FEB26:09:00:00,Utilities,-60,2230,utilities_payment,,
CUST00002,ACC000003,2026-02-28,28FEB26:20:00:00,Salary,9000,9999,salary,,
CUST00001,ACC000001,2026-02-10,10FEB26:09:00:00,Utilities,-40,2040,utilities_payment,,
CUST00001,ACC000001,2026-02-11,11FEB26:09:00:00,Salary,1800,3840,salary,,
CUST00001,ACC000001,2026-02-12,12FEB26:09:00:00,Salary Sweep,-1400,2440,salary_sweep,,
CUST00001,ACC000001,2026-02-17,17FEB26:09:00:00,Other Income,90,2530,other_income,,
CUST00001,ACC000001,2026-02-18,18FEB26:09:00:00,Invest Deposit,-300,2230,investment_deposit,,
CUST00001,ACC000001,2026-02-19,19FEB26:09:00:00,Taxi,-50,2180,purchase,TAXI,4121
CUST00001,ACC000001,2026-02-19,19FEB26:10:00:00,Taxi,25,2205,purchase_refund,TAXI,4121
CUST00001,ACC000001,2026-02-20,20FEB26:09:00:00,Invest Withdraw,85,2290,investment_withdrawal,,
CUST00001,ACC000002,2026-02-27,27FEB26:16:00:00,Health,-27,473,purchase,HEALTH,5912
CUST00001,ACC000002,2026-02-27,27FEB26:10:00:00,Groceries,-10,500,purchase,GROCERY,5411
`;

test('the deployed dataset loader groups by owner and account and preserves the latest balance', async () => {
  const encoded = gzipSync(csv).toString('base64');
  const transactions = await loadEncodedCsvTransactions({ encoded, customerId: 'CUST00001' });
  const app = createContainer({ transactions });
  assert.equal(transactions.asOf(), '2026-02-27');
  assert.equal(transactions.list().length, 11);
  assert.equal(transactions.invested(), 215);
  const accounts = await app.handle('GET', '/api/accounts');
  assert.equal(accounts.totalBalance, 2703);
  const account = await app.handle('GET', '/api/accounts/ACC000002');
  assert.equal(account.balance, 473);
  assert.deepEqual(account.transactions.map((t: { category: string }) => t.category), ['Health', 'Groceries']);
});

test('refunds reduce spending, sweeps reserve cash and multiple utility payments all count', async () => {
  const encoded = gzipSync(csv).toString('base64');
  const transactions = await loadEncodedCsvTransactions({ encoded, customerId: 'CUST00001' });
  const app = createContainer({ transactions });
  const flow = await app.handle('GET', '/api/trainer/cashflow');
  assert.equal(flow.baskets[0].lines[0].monthly, 100);
  assert.equal(flow.transferReserve, 1400);
  assert.equal(flow.income, 3044, 'just the historical salary scaled by 18 days, with refunds and other income excluded');
  assert.equal(flow.safe.until, '2026-03-11');
  assert.ok(!flow.baskets.flatMap((b: { lines: { label: string }[] }) => b.lines).some((line: { label: string }) => /sweep|invest/i.test(line.label)));
  const { answer } = await app.handle('POST', '/api/trainer/chat', { messages: [{ role: 'user', text: 'How much did I spend on taxis this month?' }] });
  assert.equal(answer.figure, '€25');
  assert.match(answer.text, /1 refund/);
});
