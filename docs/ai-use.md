# How a coding agent was used

Almost all of the code, tests and first drafts of the docs were written by Claude Code (the Claude desktop app,
model Claude Opus 5.5), in one conversation that ran from planning (2026-11-23 and 24) through the build. I set the scope, the
stack and the rules, answered the agent's questions, and made the product and design choices; each one is recorded
with its date in the plan. Commits carry a `Co-Authored-By` line for the agent.

## How it was directed

- **The plan.** [plan.md](plan.md) is a cleaned copy of the planning document, agreed with me question by question
  before the first line of code and kept as the source of truth through the build. Its model choices rest on the
  test written up in [model-check.md](model-check.md), with criteria written before each run.
- **The project's rules.** [CLAUDE.md](../CLAUDE.md) is in the repo from the first commit, with the way of working,
  the code and writing rules, and the look of the web app. The agent's session ran from a folder above the repo,
  where the file isn't loaded on its own, so the file says to read it at the start of every step.
- **My global rules**, which apply to every session on my machine. The parts that applied are quoted at the end,
  word for word; `[…]` marks what is left out (GitHub accounts, pull requests, and how replies to me are written).
- **Notes the agent kept between sessions**, in its memory folder. The ones about this project: the plan is the
  source of truth; the review workflow from step 5; no models loaded after 2026-11-25 until I say so; every staged
  diff scanned for secrets and personal details before a commit. Notes about my machine (running Docker through WSL,
  for one) are left out.
- **Tools.** The advisor, a stronger model (Fable) that sees the whole session, consulted before choosing an
  approach and before calling a step done. Fresh general-purpose subagents as reviewers. The built-in browser, for
  checking the web app by hand. One plugin, ponytail 5.3.3, whose hooks add its rules for the smallest
  complete change at the start of each session and to every subagent, the reviewers included, and track its level
  in each prompt; there are no other hooks. Two skills were loaded once, at the start of planning: the built-in
  browser's instructions, and the Claude API reference, which the app doesn't use.

## How the work was checked

- Every step ended with reviews by a fresh agent that hadn't seen the work: up to three per step, each waited for,
  until step 4; from step 5, at most two, each running in its own git worktree alongside the next step. Each review
  read the whole diff and the code around it; its findings were fixed and every check re-run.
- `docker compose run --rm test` (lint, type checks and all tests, in containers) before every commit.
- From step 5, review fixes were checked by undoing them to see their new tests fail (noted in the time log and
  the mistakes log).
- Real-model runs ([model-runs.md](model-runs.md)): through step 4 against criteria written before the run, from
  step 5 as hand checks. A search benchmark whose decision rule was committed before the first run
  ([benchmark.md](benchmark.md)).
- `npm run scan:phrases` ([scripts/phrase-scan.mjs](../scripts/phrase-scan.mjs)) before each commit, for wording that
  reads as generic AI output; the house style it enforces is in CLAUDE.md. Every staged diff was also scanned for
  secrets, emails, local paths and machine details.

## Mistakes caught

[ai-log.md](ai-log.md) has every mistake caught in the agent's output, logged as it happened, each with what caught
it and what changed. One example from step 7: the design notes said a short document goes to the model whole, but
each ranking keeps only its top 20 passages, so a short document of more passages could lose some. The check the plan
had left for that step caught it; a document that fits the passage budget is now sent whole, with a test of 30
passages.

## The global rules that applied

As they stood through the build (last changed on 2026-11-23, before planning).

```text
## Git and pull requests

[…]
- Never skip or weaken git hooks and checks (no `--no-verify`).
[…]

## Advisor

- At the start of each task, rate how hard it is. Small and easy (a lookup, a short answer, a one-file or mechanical
  edit): don't call the advisor (Fable). Anything harder (several files or repos, an unclear approach, money, security,
  data, prod, migrations, anything hard to undo): run decisions past it before committing to an approach, before
  anything hard to undo or outward-facing, when stuck, and before saying the task is done.
- When you hand a task to a helper (an agent or a separate session), rate it the same way and put one line in the
  brief: `Advisor: no (small, easy task)` or `Advisor: yes, before choosing the approach and before reporting done`.
  A helper follows that line; with none, it rates the task itself.
- The advisor's OK is not the user's OK. Pushes, merges, deletions and prod changes still need the user's word.
- If this session has no advisor tool, say so in your report and carry on.

## Asking before acting

- Before any implementation, change, new feature or redesign, be 100% aligned with the user on the vision. Never
  assume: ask. The one exception: a small change the user has already described exactly (e.g. "rename this button to
  Save") is just done.
- Ask in the batch 1 style below: simple, short questions that someone who has never seen the codebase understands.
  Ask all of them at once, as a short numbered list or a question dialog.
- Facts the code can answer, look up yourself. Ask the user about goals, choices and what they want.
- When the user says to choose the best option: run the whole problem past the advisor (Fable), present the chosen
  solution in the batch 1 style, and ask for confirmation before doing it.
- Memory: propose each new memory in one short line and save it only on the user's yes (a "remember this" from the
  user is that yes).

## Explaining things

[…]

## Helpers (handing work to agents or sessions)

The user never reads messages between agents, so write them for the receiving agent: dense and exact, without the
batches above. Correct, in-depth work matters more than speed. A helper knows only its brief: not your conversation,
not your memory. A project's own CLAUDE.md can add specifics on top of this section. It covers helpers that change
code; a read-only agent (a search, a review) only needs a clear brief.

- **Isolation:** each helper works in its own copy of the code (a git worktree), never two helpers in one copy. A
  worktree inside WSL is a good isolation step: a separate Linux environment, so each helper's installs, ports and
  tools stay apart from Windows and from each other. Don't touch a worktree, branch or checkout another session made.
- **Brief**, in this order:
  - `Task:` where to work (repo, worktree, base branch). Read first: the "Helpers" section of
    [this file] and the project's own `CLAUDE.md` / `AGENTS.md`.
  - `Goal:` the observable result that means done.
  - `Context:` the decisions that apply, quoted with date and who decided; related PRs/tickets; file:line starting
    points. Name secrets, never paste their values.
  - `Observed:` the facts (errors, data, steps to reproduce). `Suspected:` your guess at the cause, which the helper
    tries to disprove before building on it.
  - `Out of scope:` nearby things not to change (list them in the report instead).
  - `Stop and report if:` a product choice isn't settled, a migration or config change isn't in the brief, or the
    work is wider than briefed. Don't guess.
  - `Advisor: yes/no …` (see "Advisor"). `Advisor: yes` also means plan first: return the plan as the report, with no
    code, and stop; the go-ahead comes as a follow-up message.
- **Report**, in this order:
  - First line: `DONE`, `BLOCKED` or `NEEDS DECISION`, and one line why.
  - Branch, commit hashes, pushed or not, and the commit hooks' result.
  - Changes per file, with file:line and why.
  - Evidence: each claim marked `ran` (exact command and result line), `read` (file:line) or `not checked`. A bug fix
    includes a test that failed before the fix and passes after it, or says why none can be written.
  - Own choices the brief didn't settle, each with the alternative rejected.
  - Questions, each with options and a recommendation. Product questions are the user's: don't settle them yourself.
  - Handed back: checks the helper couldn't run.
  - Noticed but out of scope: bugs or risks seen and not touched.
  - `Advisor: used`, `not used` or `not available`.
  - Error text pasted exactly, never summarized.
- **After a report** (a report is a claim, not proof):
  1. Read the whole diff yourself.
  2. Every time a helper reports `DONE`, launch a fresh review agent to catch what's still wrong. Give it the task,
     base and the brief's goal and context, not the helper's conclusions. It reads the whole diff and the code around
     it, and returns findings with file:line, why each is wrong, and its evidence.
  3. Send the real findings back to the same helper with `SendMessage`. When it reports `DONE` again, a new review
     agent reads the whole diff again and checks the earlier findings were fixed.
  4. **At most 3 reviews per helper.** If real issues remain after the third, stop and take them to the user.
  5. The helper's own choices and product questions go to the user in the user's reply style; never paste a report.
```
