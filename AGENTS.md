## General Principles
- Prefer clear, concise writing.
- Prefer one-line sentences when possible.
- Wrap generated Markdown at 80 chars.
- Use repo-relative paths or plain code references.
- Do not add absolute filesystem paths.
- Do not hardcode environment-specific paths or similar host-layout assumptions
  into repo code.
- Do not write business data, real customer data, or real repository
  identifiers into tests; use generic placeholders and synthetic fixtures
  instead.
- Add comments when they improve clarity.
- Do not cheat around constraints, tests, or review expectations.
- Diagnose the root cause before fixing a bug; do not patch symptoms while the
  actual failure mode is still unclear.
- If you make a mistaken fix or a wrong turn, revert it cleanly instead of
  leaving incorrect changes behind.
- Do not take shortcuts, fake completion, or use workaround-only "fixes" to
  bypass the real engineering work.
- Do not report intermediate results or say "if you want" when the next step
  is clear; default to taking action directly.
- If you are uncertain, ask instead of fabricating results under pressure.
