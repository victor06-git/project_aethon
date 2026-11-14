export const money = (n: number, digits = 2): string => new Intl.NumberFormat('en-GB', {
  style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits
}).format(n);

export const shortDate = (iso: string): string => new Date(iso + 'T00:00:00')
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
