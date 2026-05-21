---
name: pr-ready
description: Run the tix pre-PR merge-ready gate on the current branch. Verifies zero must-fix review findings, green `pnpm check`, and a clean rebase on `origin/main`. Pass / fail — if all three gates pass, the branch is ready for `gh pr create`. Use when the user wants to confirm a branch is merge-ready before opening a PR, asks "is this ready?", "ready to ship?", "ready for PR?", or invokes `/pr-ready`.
---

# Pre-PR merge-ready gate

Sibling of [[pr-review]] (advisory local review) and [[pr-review-pr]] (active GitHub PR review). The merge-ready gate is **pass / fail** — every gate below must be green before the branch is considered ready.

## Gates (in order, stop on first failure)

1. **Branch ≠ `main`.** Refuse on `main`; the gate is for feature branches headed for PR.

2. **`pnpm check` clean** — full suite: lint + format + types + tests + build. The Stop hook only covers `fix` + `check-types`; this runs the rest.

3. **Zero must-fix review findings** — apply the [[pr-review]] [Review dimensions](../pr-review/SKILL.md#review-dimensions) against `git diff main...HEAD` (three-dot range). Should-fix and nits don't block the gate but are listed in the report.

4. **Clean rebase on `origin/main`**:
   - `git fetch origin main`
   - `git log --oneline origin/main..HEAD` → commits ahead (must be ≥ 1).
   - `git log --oneline HEAD..origin/main` → commits behind. If > 0, the gate fails.
   - **Do not rebase the user's working branch.** If behind, report and offer: _"Try the rebase in a worktree to confirm it's clean? (y/n)"_ — only attempt the rebase in a throwaway worktree, never on the user's HEAD.

## Workflow

1. Run gates 1 → 4 in order. **Stop on the first failure**; reviewing code that fails earlier gates wastes effort.
2. **On all-green**, print the ready summary (format below) including a suggested PR title pulled from the topmost commit subject.
3. **On any failure**, print the gate table with the failed gate(s) marked, then the relevant detail:
   - Gate 2 failure → the `pnpm check` failure output (one-line summary + which step failed).
   - Gate 3 failure → the [[pr-review]] [Output format](../pr-review/SKILL.md#output-format) report (full must-fix list).
   - Gate 4 failure → list of commits behind + the worktree-rebase offer.
4. **Don't push, don't open the PR, don't apply fixes.** Offer to invoke [[pr-review]] for interactive fix-it on must-fix items, but the user decides. The gate's job is to say go / no-go.

## Output format

````md
# Merge-ready check: <branch> → origin/main

| Gate                          | Status               |
| ----------------------------- | -------------------- |
| Branch ≠ `main`               | ✅                   |
| `pnpm check`                  | ✅ / ❌              |
| Zero must-fix review          | ✅ / ❌ (N findings) |
| Clean rebase on `origin/main` | ✅ / ❌ (N behind)   |

<if any ❌, expand the failing gate(s) below with the relevant detail>

<if all ✅>
**Ready.** Suggested PR title: `<topmost commit subject>`.

```sh
gh pr create
```

</if>
````

## Don'ts

- Don't auto-rebase the working branch. Worktrees only, with explicit user opt-in.
- Don't auto-fix must-fix items. Hand off to [[pr-review]] for the interactive fix loop.
- Don't open the PR for the user — printing the suggested command is enough.
- Don't run gate 3 if gate 2 fails; lint / type errors will dominate the review and waste effort.
