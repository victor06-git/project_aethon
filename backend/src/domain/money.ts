// Money helpers. Pure functions, no I/O.
export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const sum = <T>(items: T[], pick: (x: T) => number): number => round2(items.reduce((s, x) => s + pick(x), 0));
