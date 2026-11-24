# Agent rules for this repo

These are the rules the coding agent followed while building this project. They are committed because the brief
asks for the instructions actually used. The broader personal rules that also applied are summarised in
`docs/ai-use.md`, written at the end of the build.

## Way of working

- One step at a time. Each step ends with a full code review by a fresh reviewer agent that hasn't seen the work
  being done. Its findings are fixed and every check is re-run, with another review after substantial fixes (at
  most three reviews per step). Only when the step is polished is it committed and pushed.
- Ask the author before loading a local model, since it takes most of the machine's memory.
- Each step ships with its own tests and adds its own section to `DESIGN.md` while the reasons are fresh.
- Read this file at the start of every step. The agent's session runs from a parent folder, so it may not load it
  automatically.
- Tests run with `docker compose run --rm test`. A step isn't done until that passes.
- Mistakes caught in agent output go into `docs/ai-log.md` when they happen, with what caught them.
- Time goes into `TIMELOG.md`, taken with `date` at both ends, breaks as their own rows.

## Code

- TypeScript strict, ES modules, Node 22. Fastify with zod schemas on every route. Kysely over `pg`; raw SQL where
  pgvector or full-text search need it. BullMQ on Redis.
- The smallest change that fully solves the step. No abstractions, options or helpers nobody needs yet.
- Comments only for the why. No narrating comments, no doc comment on every function, no banner comments.
- Validate at the edges (HTTP input, model output, parser output). Never trust a filename, a Content-Type or model
  text.
- No secrets in the repo. Settings come from the environment; `.env.example` lists them without credentials.
- Prettier and ESLint decide formatting.

## Writing (README, DESIGN.md, docs, comments, commit messages, UI text)

- Plain and specific, like explaining to a colleague. `DESIGN.md` uses "I" only for decisions the author made and
  has read; the rest is neutral.
- Real numbers and real limits. Nothing manufactured: no invented dead ends, staged typos or rewritten history.
- Avoid: tildes on numbers (write "about 30"); bullets that all share one shape and length; abstract filler
  ("robust", "seamless", "leverage", "comprehensive", "end to end", "production-grade" and the rest of the list in
  `scripts/phrase-scan.mjs`); summaries that repeat what came before; emoji or title case in headings; bold
  everywhere; tables where a sentence would do; chains of em dashes.
- Length: README about 150 lines at most; `DESIGN.md` about 2,000 words at most, with detail in `docs/`.
- Commit messages: short, imperative, one checkpoint each, ending with the `Co-Authored-By` line for the agent.
- Run `npm run scan:phrases` before each commit.

## Look (web UI)

- Dark only, warm near-black greys, thin borders, small radii. Charis SIL for document text and headings, Inter for
  the interface, both self-hosted. One orange accent, used sparingly. No gradients, glows, emoji, sparkle icons,
  robot avatars, card grids or typing animations.
- Light text on solid orange fails contrast; quote highlights are a faint orange tint with an underline.
