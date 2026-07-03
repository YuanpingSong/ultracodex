/** NO_COLOR (https://no-color.org): any non-empty value disables color. */
export function colorsEnabled(): boolean {
  const v = process.env.NO_COLOR;
  return v === undefined || v === "";
}

/** Ink color prop helper — undefined when NO_COLOR is set. */
export function col(name: string): string | undefined {
  return colorsEnabled() ? name : undefined;
}
