# Scheduling runs

## Why a manager, not a daemon

`ultracodex schedule` manages cron entries and per-project schedule specs. It
does not install a resident ultracodex process, supervisor, socket, or timer.
Cron is the only thing that wakes up; each wakeup runs:

```
ultracodex schedule exec <name>
```

That keeps unattended work inspectable and easy to remove. The durable state is
just text under `.ultracodex/schedules/`, plus one tagged crontab line per
active schedule.

## Quick start

Create a schedule from the project directory:

```
ultracodex schedule add digest --every 30m -- run digest.js
ultracodex schedule add nightly --daily 18:30 -- run nightly-review
ultracodex schedule add cleanup --cron "15 9 * * 1" -- node scripts/cleanup.mjs
```

List, pause, resume, and remove schedules:

```
ultracodex schedule ls
ultracodex schedule pause digest
ultracodex schedule resume digest
ultracodex schedule rm digest
```

Logs stay in `.ultracodex/schedules/<name>.log`. Removing a schedule deletes
the spec and crontab line, but keeps the log for post-mortems.

## Command reference

```
ultracodex schedule add <name> (--every <dur> | --daily <HH:MM> | --cron "<expr>") [--until-done] [--max-runs <n>] -- <command...>
ultracodex schedule ls [--json]
ultracodex schedule pause <name>
ultracodex schedule resume <name>
ultracodex schedule rm <name>
```

Names are lowercase slugs: letters, digits, and hyphens, starting with a
letter or digit.

`--every` accepts `1-59m` or `1-23h`, mapped to ordinary five-field cron:
`*/N * * * *` for minutes and `0 */N * * *` for hours. `--daily HH:MM`
maps to `MM HH * * *`. `--cron` is the escape hatch and validates only that
the expression has five fields.

If the scheduled command starts with `run`, ultracodex resolves the script or
saved workflow at add time and later invokes its own CLI with `--json`.
Other commands are executed directly with `shell:false` and PATH lookup at
execution time.

## The --until-done contract — a run result object with done:true retires the schedule

`--until-done` is only valid for scheduled `run` commands. The workflow must
return an object when run with `ultracodex run ... --json`. When that object
contains `done: true`, the schedule is retired:

```js
export const meta = { name: "poller" };

const item = await agent("check the queue");
return { done: item === null, item };
```

Retirement removes the crontab line, sets the spec status to `retired`, and
records `retiredReason: "done"`. `--max-runs <n>` retires the schedule with
`retiredReason: "max-runs"` after the nth execution.

## How crontab is managed — tags, one line per schedule, foreign lines untouched

Every ultracodex-owned line ends with:

```
# ultracodex:<name>@<hash8>
```

`hash8` is the first eight hex characters of `sha256(projectDir)`, so two
projects can both have `nightly` without colliding. Managing a schedule only
rewrites lines with that exact tag. Other schedules and foreign crontab lines
are preserved byte-for-byte.

The installed line changes directory into the project, invokes the captured
Node binary and CLI path, and appends all output to the schedule log. Paths are
single-quoted and percent signs are escaped for cron.

## Missed-run nudges

`ultracodex ls`, `ultracodex run`, and `ultracodex schedule ls` check active
`--every` and `--daily` schedules. If the time since the last run, or creation
time for a never-run schedule, exceeds 1.5x the expected interval, ultracodex
prints a dim warning to stderr:

```
schedule 'digest' looks overdue (expected ~2026-01-01T12:30:00.000Z) — is cron running?
```

Raw `--cron` schedules are exempt in v1 because ultracodex does not try to
calculate arbitrary next-run times.

## Testing with ULTRACODEX_CRONTAB_FILE

Set `ULTRACODEX_CRONTAB_FILE` to make scheduler commands read and write a plain
file instead of the real crontab:

```
tmp=$(mktemp -d)
ULTRACODEX_CRONTAB_FILE="$tmp/crontab" ultracodex schedule add demo --every 5m -- node -e 'console.log("ok")'
cat "$tmp/crontab"
```

This is how the test suite stays hermetic. A missing override file is treated
as an empty crontab.

## Limitations — cron's bare env, local time, macOS Full Disk Access note, no log rotation, launchd/systemd planned

Cron starts with a sparse environment. Ultracodex captures `PATH`, the Node
binary, and the CLI path at add time, but any other environment variables must
come from the command itself, project files, or cron configuration.

Cron uses the machine's local time. `--daily 18:30` means 18:30 on that host,
including the host's daylight-saving behavior.

On macOS, cron may need Full Disk Access before it can read protected
directories such as Desktop, Documents, or Downloads. If a schedule works by
hand but not from cron, check the schedule log and the system privacy settings.

Logs are append-only and are not rotated yet. External log rotation is fine as
long as it preserves the schedule files themselves. Native launchd/systemd
backends are planned; v1 intentionally stays on portable crontab management.
