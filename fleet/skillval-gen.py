#!/usr/bin/env python3
"""Generate clean test folders for the skill-validation rounds.

Usage: python3 fleet/skillval-gen.py /tmp/skillval-r1
Creates <base>/<TEST>-<backend>/ for every test x backend, with fixtures and
skills installed the way a real user's project would have them.
"""
import os, subprocess, sys, shutil, pathlib

BASE = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/skillval-r1")
BACKENDS = ["cx", "cl", "oc"]
UCX = shutil.which("ultracodex") or "ultracodex"

CONTRADICTIONS = {
    "notes-a.txt": "The launch happened in March 2024.\nThe system supports at most 5 concurrent users.\nAlice leads the infrastructure team.\n",
    "notes-b.txt": "The launch happened in June 2024.\nThe system supports at most 5 concurrent users.\nBob has led the infrastructure team since 2023.\n",
    "notes-c.txt": "Post-launch review (photos dated March 2024).\nLoad tests passed with 50 concurrent users.\n",
}

WF_JS = """export const meta = { name: 'echo-args', description: 'returns its args plus one agent haiku' }
const topic = args?.topic ?? 'silence'
const haiku = await agent(`Write one haiku about ${topic}. Return only the three lines.`, { label: 'haiku-r1' })
return { topic, haiku, done: true }
"""

FAIL_JS = """export const meta = { name: 'doomed', description: 'always fails' }
const x = await agent('Say OK', { label: 'ok' })
throw new Error('intentional failure: downstream service unavailable')
"""

TODO_FILES = {
    "alpha.md": "# Alpha module\nClean paragraph.\nTODO: replace the retry constant with config\nMore prose.\n",
    "beta.md": "Beta notes.\nFIXME: the cache is never invalidated\nTODO: add pagination to the list endpoint\n",
    "gamma.md": "Gamma overview.\nAll good here.\nTODO: document the error codes\n",
    "delta.md": "Delta appendix.\nFIXME: timezone handling assumes UTC\nTODO: remove the deprecated flag\n",
}  # exactly 6 planted markers

DIGEST_JS = """export const meta = { name: 'digest', description: 'one-agent digest' }
const r = await agent('Say DIGEST-OK and nothing else.', { label: 'digest-r1' })
return { digest: r, done: false }
"""

UNTIL_JS = """export const meta = { name: 'until', description: 'reports done immediately' }
const r = await agent('Say UNTIL-OK and nothing else.', { label: 'until-r1' })
return { result: r, done: true }
"""

COVERAGE = """[groups.widgets]
title = "Widgets"
entities = ["wproc", "wstore"]
"""

INBOX_ITEM = """---
id: note-1
type: notify
from: ops
received: 2026-07-09
refs: []
---

# Baseline note

The wproc widget shipped version 2.0 yesterday. Assess and record.
"""

TESTS = ["W1", "W2", "W3", "W4", "L1", "L2", "L3", "L4", "S1", "S2", "S3", "S4", "O1", "O2", "O3"]

def sh(cmd, cwd):
    subprocess.run(cmd, cwd=cwd, shell=True, check=True, capture_output=True)

if BASE.exists():
    shutil.rmtree(BASE)
for test in TESTS:
    for be in BACKENDS:
        d = BASE / f"{test}-{be}"
        d.mkdir(parents=True)
        # a user project has the skills installed
        sh(f"'{UCX}' sync-skills", d)
        if test == "W1":
            for name, text in CONTRADICTIONS.items():
                (d / name).write_text(text)
        elif test == "W2":
            (d / "wf.js").write_text(WF_JS)
        elif test == "W4":
            (d / "fail.js").write_text(FAIL_JS)
        elif test == "L2":
            for name, text in TODO_FILES.items():
                (d / name).write_text(text)
        elif test in ("S1", "S3"):
            (d / "digest.js").write_text(DIGEST_JS)
        elif test == "S2":
            (d / "until.js").write_text(UNTIL_JS)
        elif test == "O2":
            (d / "coverage.toml").write_text(COVERAGE)
            sh(f"'{UCX}' org init", d)
            inbox = d / "widgets" / "wproc" / "inbox"
            inbox.mkdir(parents=True, exist_ok=True)
            (inbox / "note-1.md").write_text(INBOX_ITEM)
print(f"generated {len(TESTS) * len(BACKENDS)} folders under {BASE}")
