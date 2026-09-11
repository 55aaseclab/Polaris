# Principles

## Investigation and verification

- Clarify the user's intention before acting.
- Investigate comprehensively; require root cause instead of surface fixes.
- Propose verifiable actions, then execute them.
- When fixing bugs: identify the root cause, add unit tests, fix the bug, and
  rerun the tests.
- Do not cheat around constraints, tests, or review expectations.
- Do not short-circuit verification; evidence must support the claim.

## Long-term running

- For long-running or multi-step work, prepare durable execution up front.
- Propose `/goal` or `/loop` when those tools fit and are available.
- Prefer looped progress over one-shot guesses for open-ended tasks.
- For `third_party` submodules, default to two commits: commit inside the
  submodule first, then commit the parent repo submodule pointer update.

## Self-reflection and self-improving

- Reflect after each completed task on what worked and what did not.
- Propose concrete improvements to this file when lessons apply broadly.
- Apply those updates only with the user's confirmation.

## Writing style

- Prefer clear, concise writing.
- Prefer one-line sentences when possible.
- Wrap generated Markdown at 80 chars.
- Use repo-relative paths or plain code references.
- Do not add absolute filesystem paths.
- Do not hardcode environment-specific paths or similar host-layout
  assumptions into repo code.
- Do not write business data, or real repository identifiers into tests; use
  generic placeholders and synthetic fixtures instead.
- Add comments when they improve clarity.
- Do not report intermediate results or say "if you want" when the next step
  is clear; default to taking action directly.
