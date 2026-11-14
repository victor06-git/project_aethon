// Streams the S-Pankki export without holding other customers' rows in memory.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { merchantLabel, coachKey } from '../../domain/categories';
import { round2 } from '../../domain/money';
import type { TransactionRepository } from '../../application/ports';

const HEADER = 'customer_id,bank_account_id,tx_date,tx_timestamp,category,tx_amount_eur,balance_after_eur,transaction_type,merchant_id,mcc_code';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MAX_ENCODED_CSV_BYTES = 5 * 1024 * 1024;
type CsvRow = string[];

async function readCustomerRows(input: Readable, customerId: string): Promise<CsvRow[]> {
  const rows: CsvRow[] = [];
  const prefix = customerId + ',';
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let header = false;
  try {
    for await (const line of reader) {
      if (!header) {
        if (line.replace(/^\uFEFF/, '') !== HEADER) throw new Error('Expected the S-Pankki transactions CSV header. Download the Git LFS file contents.');
        header = true;
        continue;
      }
      if (line.startsWith(prefix)) rows.push(line.split(','));
    }
  } finally {
    reader.close();
    input.destroy();
  }
  if (!rows.length) throw new Error(`No transactions for ${customerId} in the S-Pankki CSV`);
  return rows;
}

function toTransaction(row: CsvRow, i: number) {
  const [, account, date, timestamp, category, amount, balanceAfter, type, merchantId, mcc] = row;
  if (row.length !== 10 || !account || !category || !type || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !amount || !Number.isFinite(Number(amount)) || !balanceAfter || !Number.isFinite(Number(balanceAfter))) {
    throw new Error('The S-Pankki CSV contains an invalid transaction row');
  }
  const [year, month, day] = date.split('-');
  const timestampDay = `${day}${MONTHS[Number(month) - 1]}${year.slice(2)}:`;
  if (!timestamp?.startsWith(timestampDay) || !/^\d{2}:\d{2}:\d{2}$/.test(timestamp.slice(timestampDay.length))) {
    throw new Error('The S-Pankki transaction timestamp does not match the transaction date');
  }
  return {
    id: `${account}-${i}`, i, account, date, time: timestamp.slice(timestampDay.length), category, type,
    merchant: merchantLabel({ mcc, type, category }),
    merchantId: merchantId || null,
    coachKey: coachKey({ mcc, type, category }),
    amount: Number(amount), balanceAfter: Number(balanceAfter), mcc: mcc || null
  };
}

function repository(rows: CsvRow[], customerId: string): TransactionRepository {
  const list = rows.map(toTransaction)
    .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time) || b.i - a.i)
    .map(({ time, i, ...transaction }) => transaction);
  const balances = new Map<string, number>();
  for (const t of list) if (!balances.has(t.account)) balances.set(t.account, t.balanceAfter);
  const invested = round2(list.reduce((s, t) =>
    t.type === 'investment_deposit' || t.type === 'investment_withdrawal' ? s - t.amount : s, 0));

  return {
    source: 'csv',
    customerId,
    asOf: () => list[0].date,
    accounts: () => [...balances].map(([id, balance], i) => ({
      id, name: i === 0 ? 'S Account' : `Account ${i + 1}`, iban: `FI•• •••• •••• ${id.slice(-4)}`,
      balance: round2(balance), kind: 'current'
    })),
    invested: () => invested,
    list: () => list
  };
}

export async function loadCsvTransactions({ file, customerId, cacheDir }: { file: string; customerId: string; cacheDir?: string }): Promise<TransactionRepository> {
  const stat = fs.statSync(file);
  const cache = path.join(cacheDir ?? path.dirname(file), '.cache', `${encodeURIComponent(customerId)}.json`);
  let rows: CsvRow[] | undefined;
  try {
    const cached = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (cached.file === path.resolve(file) && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.rows?.length) rows = cached.rows;
  } catch { /* cache miss */ }
  if (!rows) {
    rows = await readCustomerRows(fs.createReadStream(file, { encoding: 'utf8' }), customerId);
    try {
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, JSON.stringify({ file: path.resolve(file), size: stat.size, mtimeMs: stat.mtimeMs, rows }));
    } catch { /* the source CSV can also be used from a read-only directory */ }
  }
  return repository(rows, customerId);
}

/** Load a small, explicitly configured server-side demo slice without a writable filesystem. */
export async function loadEncodedCsvTransactions({ encoded, customerId }: { encoded: string; customerId: string }): Promise<TransactionRepository> {
  const csv = gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: MAX_ENCODED_CSV_BYTES }).toString('utf8');
  return repository(await readCustomerRows(Readable.from([csv]), customerId), customerId);
}
