---
name: pr-review-pr
description: Review an open GitHub PR against tix's house style, TypeScript conventions, test discipline, and security baselines. Fetches the diff via `gh pr diff`, runs the review locally, then optionally posts the report as a single PR review (approve / request-changes / comment). Use when reviewing someone else's PR, asked to "review PR #N", "review that pull request", or "post a review on PR #…".
---

# Active PR review

Sibling of [[pr-review]] (local pre-push) and [[pr-ready]] (merge-ready gate). Shared review rules + output format live in [[pr-review]] — don't duplicate them, follow that skill's [Review dimensions](../pr-review/SKILL.md#review-dimensions) section.

## Workflow

1. **Resolve the PR** — accept a number (`123`), `#123`, or full URL:

   ```sh
   gh pr view <ref> --json number,title,headRefName,baseRefName,author,state,mergeable,statusCheckRollup,url
   ```

   Refuse if `state` ≠ `OPEN`. Stash the JSON; you'll need `number` and `url` later.

2. **Fetch the diff** — `gh pr diff <number>`. **Do not check out the branch**: review is read-only and shouldn't touch local state. (If a finding genuinely requires running code on the PR branch, flag it in Notes as "verify locally" rather than checking out unilaterally.)

3. **Skip `pnpm check`** — CI runs it on the PR. Surface check status from `statusCheckRollup`:
   - Any **failing** check → must-fix entry referencing the check name + URL.
   - **Pending** checks → Notes section, not blocking the review.

4. **Walk the diff** applying the [[pr-review]] [Review dimensions](../pr-review/SKILL.md#review-dimensions). Same severities: **must-fix / should-fix / nit**. Same finding shape: `file:line` + quoted rule.

5. **Produce the report** in the [[pr-review]] [Output format](../pr-review/SKILL.md#output-format), with the header adapted: `# PR review: #<num> "<title>" by <author>` and a link line `Branch: <head> → <base>  |  <url>`.

6. **Offer to post the review** — ask:

   > Post this on PR #N? **(approve / request-changes / comment / no)**

   Mapping:

   | Choice            | Command                                                  | When                                                                                       |
   | ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
   | `approve`         | `gh pr review <num> --approve --body-file <tmp>`         | **Only if zero must-fix.** Refuse otherwise and ask the user to confirm `comment` instead. |
   | `request-changes` | `gh pr review <num> --request-changes --body-file <tmp>` | Any must-fix items present                                                                 |
   | `comment`         | `gh pr review <num> --comment --body-file <tmp>`         | Discussion / nits-only                                                                     |
   | `no`              | (skip)                                                   | Default                                                                                    |

   Write the report body to a tempfile first (`mktemp` → `--body-file`); never pass a multi-line body inline.

7. **After posting**, echo the PR URL back so the user can verify the review landed.

## Don'ts

- Don't post per-line inline review comments — one consolidated body keeps signal high.
- Don't `approve` a PR that has must-fix findings, even if the user asks. Say so and offer `comment` instead.
- Don't merge, close, or label the PR — review only. Pushing, merging, and PR ceremony are user actions.
- Don't fetch or check out the head branch unless the user explicitly asks ("pull this PR down").
