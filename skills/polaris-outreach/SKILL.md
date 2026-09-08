---
name: polaris-outreach
description: >
  Map user intent to tools/outreach (clue-outreach) for durable multi-channel
  customer outreach: import ready leads, next-task queue, draft/approve/send,
  manual outcomes, suppress, and tick. Use when the user wants to run or
  inspect customer outreach / 外联 / 触达 after collection review.
---

# Polaris outreach

You are a thin router over `tools/outreach`. **Do not restate the full
system design.** For state model, phases P1–P5, task kinds, safety, and
portal UI, read:

- [`tools/outreach/README.md`](../../tools/outreach/README.md)

Email SMTP/IMAP hosts and env vars are managed by Polaris policy:

- [customer-outreach email guidance](https://www.jianxiaoyitech.com/docs/operations/customer-outreach-email/)

## Setup

```sh
set -a && source .env.dev && set +a
# requires POLARIS_BUSINESS_WORKSPACES_ROOT
cd tools/outreach
```

Collection hand-off must already exist:

```text
$POLARIS_BUSINESS_WORKSPACES_ROOT/<workspace>/acquisition/customer-data-collection/outputs/output.json
```

with `outreach_ready_records` (from manual review export).

## Your job

1. Parse intent (import? next tasks? approve? send? log? suppress?).
2. Emit concrete `./clue-outreach …` commands.
3. Run them when appropriate; report JSON from stdout.
4. Prefer **next-task** thinking: import → tick → next → act → next.
5. Never invent contact data; never put passwords in commands or files.

## Intent → commands

| User intent | Command |
|-------------|---------|
| Version | `./clue-outreach version` |
| Import ready leads | `./clue-outreach import --workspace <id>` |
| Materialize first drafts | `./clue-outreach tick --workspace <id>` |
| List next tasks | `./clue-outreach next --workspace <id>` |
| Status + tasks | `./clue-outreach status --workspace <id> --tasks` |
| Create email draft | `./clue-outreach draft --workspace <id> --lead-id <lead> --channel email` |
| Approve draft | `./clue-outreach approve --workspace <id> --engagement-id <eng> --actor <who>` |
| Reject draft | `./clue-outreach reject --workspace <id> --engagement-id <eng>` |
| Send dry-run | `./clue-outreach send --workspace <id> --engagement-id <eng>` |
| Send live SMTP | `./clue-outreach send --workspace <id> --engagement-id <eng> --live` |
| Mark reply | `./clue-outreach reply --workspace <id> --engagement-id <eng>` |
| Hard bounce | `./clue-outreach bounce --workspace <id> --engagement-id <eng>` |
| Log manual touch | `./clue-outreach log --workspace <id> --lead-id <lead> --channel linkedin_message --outcome <o>` |
| Suppress lead | `./clue-outreach suppress --workspace <id> --lead-id <lead> --reason <r>` |
| Mark customer | `./clue-outreach customer --workspace <id> --lead-id <lead>` |
| Show lead | `./clue-outreach show --workspace <id> --lead-id <lead>` |

Interactive queue: Polaris business portal **客户管理 → 客户触达**.

## Default loop

```sh
./clue-outreach import --workspace "$WORKSPACE_ID"
./clue-outreach tick --workspace "$WORKSPACE_ID"
./clue-outreach next --workspace "$WORKSPACE_ID"
# then approve / send / log / reply as tasks require
```

## Rules

- Outreach is stateful; always re-read `next` after a mutation.
- Do not auto-send sequences; approve remains mandatory.
- `send` without `--live` is dry-run (safe default). Integrated mode rejects
  live send until a Polaris durable action supplies admission and audit state.
- Reply / suppress / customer stop further auto tasks.
- Deep design → **`tools/outreach/README.md`**.
