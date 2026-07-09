import { CliError } from "./cli-error.js";

/** "500k" → 500_000, "1.5m" → 1_500_000, "12345" → 12345. Garbage → throws. */
export function parseBudget(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(input.trim());
  const bad = (): CliError =>
    new CliError(`invalid budget "${input}" (use e.g. 500k, 1.5m, or a plain token count)`);
  if (!m) throw bad();
  const mult = m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1;
  const n = Math.round(parseFloat(m[1]!) * mult);
  if (!Number.isFinite(n) || n <= 0) throw bad();
  return n;
}
