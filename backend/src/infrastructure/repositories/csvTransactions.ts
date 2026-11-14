// TransactionRepository adapter over the S-Pankki Junction 2026 dataset
// (tx_junction_transactions.csv, ~360 MB). Node only: never bundled into the browser.
//
// Reads one customer by streaming the file (no full load into memory) and keeps a small
// JSON cache next to it, so later starts are instant. Columns:
// customer_id,bank_account_id,tx_date,tx_timestamp,category,tx_amount_eur,balance_after_eur,transaction_type,merchant_id,mcc_code
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { merchantLabel, coachKey } from '../../domain/categories';
import { round2 } from '../../domain/money';
import type { Transaction } from '../../domain/types';
import type { TransactionRepository } from '../../application/ports';

async function readCustomerRows(file: string, customerId: string): Promise<string[][]> {
  const rows: string[][] = [];
  const prefix = customerId + ',';
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) if (line.startsWith(prefix)) rows.push(line.split(','));
  return rows;
}

function toTransaction(c: string[], i: number): Transaction {
  const [, account, date, , category, amount, balanceAfter, type, merchantId, mcc] = c;
  return {
    id: `${account}-${i}`, account, date, category, type,
    merchant: merchantLabel({ mcc, type, category }),
    merchantId: merchantId || null,
    coachKey: coachKey({ mcc, type, category }),
    amount: Number(amount), balanceAfter: Number(balanceAfter), mcc: mcc || null
  };
}

export async function loadCsvTransactions({ file, customerId, cacheDir }: { file: string; customerId: string; cacheDir?: string }): Promise<TransactionRepository> {
  if (!fs.existsSync(file)) throw new Error(`Dataset not found: ${file}`);
  const stat = fs.statSync(file);
  const cache = path.join(cacheDir ?? path.dirname(file), '.cache', `${customerId}.json`);
  let rows: string[][] | undefined;
  try {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (c.size === stat.size && c.mtimeMs === stat.mtimeMs) rows = c.rows;
  } catch { /* no cache yet */ }
  if (!rows) {
    rows = await readCustomerRows(file, customerId);
    if (!rows.length) throw new Error(`No transactions for ${customerId} in ${path.basename(file)}`);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs, rows }));
  }

  // File order is chronological per account; keep it to read the latest balance.
  const asc = rows.map(toTransaction);
  const list = [...asc].reverse();
  const balances: Record<string, number> = {};
  for (const t of asc) balances[t.account!] = t.balanceAfter!;
  // Invested = deposits into investments minus withdrawals back to the account.
  const invested = round2(asc.reduce((s, t) =>
    t.category === 'Invest Deposit' || t.category === 'Invest Withdraw' ? s - t.amount : s, 0));

  return {
    source: 'csv',
    customerId,
    asOf: () => list[0].date,
    accounts: () => Object.entries(balances).map(([id, balance], i) => ({
      id, name: i === 0 ? 'S Account' : `Account ${i + 1}`, iban: `FI•• •••• •••• ${id.slice(-4)}`,
      balance: round2(balance), kind: 'current'
    })),
    invested: () => invested,
    list: () => list
  };
}
