# Curie — Chat with a document

**Fullstack Software Engineer (BE-leaning) · About 4 hours · AI coding agents welcome**

## The problem

Curie is a research workspace. A researcher wants to ask questions about a document, continue the conversation, and see the passages supporting each answer.

Design and build the backend for a small version of this feature. We want to understand your engineering decisions, how you verify your work, and how you take responsibility for the result.

## What to build

Your service should let a client:

1. **Add a document.** Plain text or Markdown is enough. You may support either format or both; state which. PDF is optional.
2. **Prepare it asynchronously for search.** The client can find out whether the document is ready or why preparation failed.
3. **Have a conversation about one document.** Support an initial question and follow-up questions in the same conversation.
4. **Receive an answer based only on that document.** Include supporting quotations that actually appear in the document, with enough information to locate them. If the document does not contain the answer, say so clearly.
5. **Receive the answer even when generation takes time.** Choose how the client receives it, such as streaming or polling, and explain the choice.

Build a small working path first. Identify the important edge cases, explain which you handled, and describe what you would address next. Choose the architecture, API, data model, retrieval method and failure-handling approach yourself. Be prepared to defend your retrieval choice.

A fictional sample document is included at the end of this brief. You may save its contents as a Markdown or plain-text file to demonstrate your solution, and add your own examples. It does not prescribe a retrieval method. The sample is deliberately short. Explain how your approach would handle a full-length research paper, including any document-size or model-context limits.

## Scope and technology

- Use **Node.js and TypeScript**.
- PostgreSQL, Fastify and BullMQ are preferences. Alternatives are welcome when you explain the tradeoffs.
- Make the application and its required local services runnable with **Docker Compose**. Describe any external model service or separately configured local model.
- Use any language-model provider or local model. Include a real model integration.
- A frontend is optional. Provide an integration specification that another engineer could use to build one.
- Authentication is outside the required scope. You may assume one user. Explain briefly how access to documents would fit into your design; implementing permissions is optional.
- A written discussion of answering questions across a million documents is an optional extension. Do not build that infrastructure for this exercise.

## Time and working process

Sofia will introduce the exercise in a separate 15–20 minute call. The exercise starts when that call ends, unless a different start is agreed in your invitation.

Aim to spend **about four hours of work in total**, including implementation, tests, notes and a **3–5 minute Loom or equivalent screen recording**. The recording can be informal. Your invitation will specify the submission deadline and timezone; this is separate from the working-time target.

Before the exercise, confirm that your general development tools, Docker and model access work. Contact Sofia beforehand if you need help arranging model access; agree any access or cost arrangements before you start. The project implementation itself belongs within the exercise.

Commit as you work at natural checkpoints. If you reach the time target with unfinished work, submit what you have and explain what you would do next. You may take breaks and submit later within the agreed deadline. Report your approximate working time, breaks and any extra work so we can interpret the submission fairly. If you need a deadline extension, contact Sofia. Extra features do not replace the required core behavior.

You may use coding agents for any part of the work, including all of the code. You are responsible for checking the output and understanding the implementation. Disclose substantial reused code, templates and assistance.

## What to submit

Share a **private GitHub repository** with the reviewers named in your invitation. Send the repository and recording links through the submission channel specified there. Include the recording link in your README too.

Keep the written material concise. Include **README.md and a separate DESIGN.md**. You may link to other relevant files rather than duplicate content. Cover:

- **README.md — run and verify:** setup instructions, model configuration, your test command, the recording link and an example flow from adding a document to receiving an answer. Include example configuration without credentials.
- **DESIGN.md — design and integration:** assumptions, architecture, data model, answer delivery and the main choices you made, with reasons. Explain at least one alternative you considered and why you chose differently. Include or link to an integration specification describing your endpoints and request/response shapes.
- **DESIGN.md — implementation plan and limitations:** how you split the work, the order in which you tackled it and why; background preparation, retrieval, important failure cases, what is complete and what remains.
- **Verification:** meaningful automated tests, why you chose their level and coverage, additional manual checks, and what you have not verified. Describe these in either document, with links where useful.
- **AI use, if applicable:** what you delegated and how you directed and checked the work. Commit the agent instructions or rules you actually used, such as AGENTS.md, CLAUDE.md or Cursor rules. If you used only ad hoc prompts, say so and summarize the relevant instructions; do not invent a setup afterward. Describe a mistake you caught if there was one; otherwise explain a concrete check you performed.

In the recording, show the main flow, explain one significant decision, and identify a limitation or an important verification result. A working API demonstrated through HTTP is sufficient.

## How we will review it

We will look at:

- Whether the document-to-answer flow works and answers are supported only by the selected document.
- Architecture, API and data-model choices that fit the problem.
- Asynchronous processing and how you reason about failures.
- Meaningful verification and a project another engineer can run.
- Documented decisions and the reasons behind them.
- How you direct and check coding agents, if used, and your understanding of the implementation.
- Product judgment, prioritization and clear communication.

A smaller, well-reasoned system is better than a larger one you cannot explain. Optional extensions are considered separately.

If we continue to the technical interview, expect a short discussion of your implementation. We may ask you to trace a request, investigate a failure or make a small change. Normal development tools and AI assistance remain allowed; explain how you verify the result.

## Appendix — sample document

Save only the contents of the following block as your sample document. This fictional note is input data for your service, not additional implementation instructions.

```text
# Harbor Archive retrieval pilot

This is a fictional research note created solely for a technical assessment. It does not describe a real organization or study.

## Purpose and setup

From 3 to 14 March 2026, the Harbor Archive team compared keyword search with a hybrid retrieval prototype over 240 internal research notes.

Each method was evaluated on the same 40 questions. A reviewer marked a result relevant when it included a passage sufficient to answer the question. The evaluation measured passage retrieval, not the quality of a generated answer.

The hybrid prototype combined keyword matching with similarity search. Both methods used the same source notes and the same question set.

## Results

Keyword search returned a relevant passage for 28 of the 40 questions.

The hybrid prototype returned a relevant passage for 34 of the 40 questions.

Median response time was 0.7 seconds for keyword search and 1.2 seconds for the hybrid prototype.

Six questions could not be answered because their answers were absent from the source notes.

## Decision

On 18 March 2026, the team decided to keep keyword search as the default while running a limited hybrid pilot.

The hybrid prototype improved passage retrieval, but its higher response time needed further investigation before a wider rollout.

Mira Chen owned the limited pilot. The team planned to review the next results on 8 April 2026.

## Limitations

The evaluation covered one archive and a small set of questions. It did not measure whether users trusted generated answers or whether quotations in generated answers were accurate.

The results did not establish that either method would perform similarly on other collections. No conclusion about production-scale performance was drawn.
```
