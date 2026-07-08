import type { ScheduleSpec } from "./spec.js";

type ScheduleShape = ScheduleSpec | Pick<ScheduleSpec, "schedule"> | ScheduleSpec["schedule"];

function scheduleOf(spec: ScheduleShape): ScheduleSpec["schedule"] {
  return "schedule" in spec ? spec.schedule : spec;
}

function nextMinuteMultiple(nowMs: number, intervalMinutes: number): number {
  const candidate = new Date(nowMs);
  candidate.setSeconds(0, 0);
  let nextMinute = Math.ceil(candidate.getMinutes() / intervalMinutes) * intervalMinutes;
  if (nextMinute > 59) {
    candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
    return candidate.getTime();
  }
  candidate.setMinutes(nextMinute, 0, 0);
  if (candidate.getTime() < nowMs) {
    nextMinute += intervalMinutes;
    if (nextMinute <= 59) {
      candidate.setMinutes(nextMinute, 0, 0);
    } else {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
    }
  }
  return candidate.getTime();
}

function nextHourMultiple(nowMs: number, intervalHours: number): number {
  const candidate = new Date(nowMs);
  candidate.setMinutes(0, 0, 0);
  let nextHour = Math.ceil(candidate.getHours() / intervalHours) * intervalHours;
  if (nextHour > 23) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(0, 0, 0, 0);
    return candidate.getTime();
  }
  candidate.setHours(nextHour, 0, 0, 0);
  if (candidate.getTime() < nowMs) {
    nextHour += intervalHours;
    if (nextHour <= 23) {
      candidate.setHours(nextHour, 0, 0, 0);
    } else {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
    }
  }
  return candidate.getTime();
}

export function nextFireMs(spec: ScheduleShape, nowMs: number): number | null {
  const schedule = scheduleOf(spec);
  if (schedule.kind === "cron") return null;

  if (schedule.kind === "every") {
    const m = /^([1-9]\d*)([mh])$/.exec(schedule.value);
    if (m === null) return null;
    const n = Number(m[1]);
    if (!Number.isInteger(n)) return null;
    if (m[2] === "m") return n >= 1 && n <= 59 ? nextMinuteMultiple(nowMs, n) : null;
    return n >= 1 && n <= 23 ? nextHourMultiple(nowMs, n) : null;
  }

  const m = /^(\d{2}):(\d{2})$/.exec(schedule.value);
  if (m === null) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  const candidate = new Date(nowMs);
  candidate.setHours(hh, mm, 0, 0);
  if (candidate.getTime() < nowMs) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}
