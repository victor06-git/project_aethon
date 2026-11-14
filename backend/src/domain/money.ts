// Money helpers. Pure functions, no I/O.
export const round2 = (n: number): number => {
  const cents = n * 100;
  // Preserve half-cent ties when the original decimal cannot be represented exactly as a float.
  const rounded = Math.sign(cents) * Math.round(Math.abs(cents) + Math.abs(cents) * Number.EPSILON) / 100;
  return rounded || 0;
};
export const sum = <T>(items: T[], pick: (x: T) => number): number => round2(items.reduce((s, x) => s + pick(x), 0));
