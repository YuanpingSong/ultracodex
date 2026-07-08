export interface ScheduleExecOutcome {
  ts: string;
  ok: boolean;
}

const EXEC_OUTCOME_RE = /^(\d{4}-\d{2}-\d{2}T[^\s·]+) · exit (-?\d+)(?: · |$)/;

export function parseScheduleLogTail(text: string, max = 5): ScheduleExecOutcome[] {
  const cap = Math.max(0, Math.trunc(max));
  if (cap === 0) return [];
  const outcomes: ScheduleExecOutcome[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = EXEC_OUTCOME_RE.exec(line);
    if (m === null) continue;
    outcomes.push({ ts: m[1]!, ok: Number(m[2]) === 0 });
  }
  return outcomes.slice(-cap);
}
