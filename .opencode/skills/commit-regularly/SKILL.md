---
name: commit-regularly
description: Commit the working tree frequently so no uncommitted state is ever lost. Use whenever a coding session is making progress — after a working change, after a fix is verified, or at natural stopping points. Trigger keywords: "commit", "zacomituj", "zapis", "wrzuć do gita", "nie zgub stanu".
---

# Commit regularly

This project has a history of losing work because changes lived only in the
working tree (see 2026-09-19 → 09-20: the "evening state" with hearts, camera
and rules was never committed and got overwritten by a `git show` restore).
Rule: **never let an uncommitted working state be the only copy of working
code.**

## When to commit

- After each change that builds and works (BUILD SUCCEEDED / verified behavior).
- After every fix, regardless of how small.
- At natural stopping points: end of a task, before switching topic, before
  any operation that could overwrite files (`git show … >`, `git restore`,
  `git checkout`, regenerating projects via `xcodegen`, `rm`).
- Before any command that touches the same files you just edited.

## Before committing

1. Inspect: `git status`, `git diff`, `git log --oneline -10`.
2. Stage only intended files — never secrets (`.env`, `*.pem`, `key.pem`,
   `readproof.db`, `node_modules`), never junk/build artifacts
   (`build/`, `DerivedData/`, `.DS_Store`, stray files like `=22.0.0.`,
   `.watch2.py` unless intentional).
3. Keep commit messages in the repo's style: conventional prefix
   (`feat:`, `fix:`, `chore:`, `ui:`, `design:`, `db:`) + short Polish or
   English summary, bullet body when non-trivial.

## Tip

If a working-tree version is important and you're about to risk overwriting
it, commit it first — even as its own small commit — rather than relying on
backups in `/tmp`.