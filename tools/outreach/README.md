# clue-outreach

`clue-outreach` is the durable, multi-channel customer outreach system for
Polaris business workspaces. It consumes human-reviewed
`outreach_ready_records`, keeps long-lived lead state, and always answers:

> **what is the next operator task?**

The workflow `sync` command also accepts generic v2 collection records whose
customer fields are carried in `payload.customer_lead`.

The eventual Polaris workflow skill is a thin intent → command router over
this implementation.

Operational UI: `apps/admin-portal` → 客户管理 → **客户触达** (not a
separate app; the repo portal is `admin-portal`).

Email transport notes (SMTP/IMAP host table, credentials): see
[`docs/customer-outreach-email.md`](../../docs/customer-outreach-email.md).
That document is the **email channel appendix**; this README is the system
design.

## Why a long-running system

Outreach is not a one-shot “send after collection” job. Leads change over
days and weeks:

```text
observe state → choose next action → execute (or assign human)
      ↑                                      |
      └──────── event / time / reply ────────┘
```

The unit of work is a **task**, not a batch of emails.

| Layer | Meaning |
|-------|---------|
| Lead | Company / candidate identity + relationship stage |
| ContactPoint | email / phone / form / linkedin / … + availability |
| Engagement | One attempt (draft → approve → send/log → outcome) |
| Task | Operator-facing next step derived from state |

## Layout

```text
$POLARIS_BUSINESS_WORKSPACES_ROOT/<workspace>/acquisition/customer-data-collection/
├── outputs/output.json              # hand-off: outreach_ready_records
├── work/outreach-state.json         # durable outreach state (this tool)
└── outputs/outreach-log.jsonl       # append-only save/event log
```

State is **never** written back into collector `input.json` / run outputs.

## Phases (P1–P5)

| Phase | Scope | Status in 0.1.0 |
|-------|--------|-----------------|
| **P1** | Lead relationship + engagement lifecycle; email first touch (draft → approve → send dry-run/SMTP); reply/bounce/suppress | Implemented |
| **P2** | Multi-channel contact points; manual outcome logging (phone, LinkedIn, form, …) | Implemented |
| **P3** | Strategy `next` / `tick`; wait windows; suggest next channel (no auto multi-send) | Implemented |
| **P4** | Optional follow-up email drafts when `config.auto_follow_up=true`; still human-approved | Scaffolded |
| **P5** | Admin portal task queue UI; WeCom internal notify hooks (notify = out of band) | Portal UI in 0.1.0; WeCom later |

Default policy: **no unattended drip sequences**. `tick` may create drafts;
humans approve and send.

## Relationship vs engagement status

**Lead.relationship** (business stage):

| Value | Meaning |
|-------|---------|
| `new` | Imported, not touched |
| `first_touch` | Soft stage after bounce recovery / early touch |
| `waiting` | Sent something; cooling down |
| `engaged` | Customer replied — sales owns it |
| `suppressed` | Stop all auto outreach |
| `closed` | Manually closed without customer |
| `customer` | Already a customer / converted |

**Engagement.status** (one attempt):

`draft` → `approved` → `queued` → `sent` → (`replied` \| `failed`)<br>
or `cancelled`.

## Task kinds (`next`)

| kind | Operator action |
|------|-----------------|
| `handle_reply` | Sales takeover |
| `retry_failed` | Fix / resend / cancel |
| `approve_draft` | Approve or reject draft |
| `send_engagement` | Send approved engagement |
| `suggest_first_touch` | Create first email draft (`tick` does this) |
| `suggest_manual_channel` | Call / LinkedIn / form (log outcome) |
| `waiting` | Hidden by default; cool-down |

Priority: reply > failed > approve > send > first touch > manual > waiting.

## CLI

```sh
set -a && source .env && set +a
cd tools/outreach

./clue-outreach version
./clue-outreach import --workspace <id>
./clue-outreach tick --workspace <id>
./clue-outreach next --workspace <id>
./clue-outreach status --workspace <id> --tasks

./clue-outreach draft --workspace <id> --lead-id candidate:… --channel email
./clue-outreach approve --workspace <id> --engagement-id eng-… --actor alice
./clue-outreach send --workspace <id> --engagement-id eng-…          # dry-run
./clue-outreach send --workspace <id> --engagement-id eng-… --live   # standalone SMTP

./clue-outreach reply --workspace <id> --engagement-id eng-…
./clue-outreach bounce --workspace <id> --engagement-id eng-…
./clue-outreach log --workspace <id> --lead-id candidate:… \
  --channel linkedin_message --outcome connected --actor bob
./clue-outreach suppress --workspace <id> --lead-id candidate:… \
  --reason opt_out
./clue-outreach customer --workspace <id> --lead-id candidate:…
./clue-outreach show --workspace <id> --lead-id candidate:…
```

All commands print JSON on stdout. Failures: exit `2` with
`{"ok":false,"error":…}`.

### Typical operator loop

```text
import  →  tick  →  next
              │
              ├─ approve_draft → send (dry-run then --live)
              ├─ handle_reply  → assign sales / suppress
              ├─ suggest_manual_channel → log outcome
              └─ retry_failed → fix or cancel
```

## Config (in state)

```json
"config": {
  "wait_days": 7,
  "max_auto_touches": 1,
  "auto_follow_up": false
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `wait_days` | 7 | Cool-down after a send before manual suggestions |
| `max_auto_touches` | 1 | Max auto email touches before waiting/manual |
| `auto_follow_up` | false | If true, after wait may suggest another email draft |

## Email send

- Default `send` is **dry-run** (records `sent` with dry-run message id).
- `--live` requires `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` (and optional
  `OUTREACH_FROM_*`). See email appendix.
- In Polaris mode, `--live` is rejected by both the portal and this direct CLI.
  Polaris must own the durable permission, idempotency key, outbox execution,
  and audit record before an integrated SMTP send can be enabled.
- IMAP inbox sync is **not** in 0.1.0; use `reply` / `bounce` / portal
  actions (or a later worker).

## Safety

1. Never store SMTP/IMAP passwords in workspace state or git.
2. Only public business contacts from collection/review.
3. Reply, unsubscribe, hard bounce, customer → stop auto follow-ups.
4. Re-import does not resurrect `suppressed` / `customer` leads.
5. Prefer small daily volume when going `--live`.

## Admin portal (P5)

Under **客户管理 → 客户触达**:

1. Import ready leads from collection `output.json`
2. Run `tick` to materialize first-touch drafts
3. Work the **next tasks** queue: approve, reject, send (dry-run/live),
   log manual, suppress, mark replied
4. Inspect lead detail (relationship, contact points, engagements)

API: `GET/POST /api/workspaces/[workspace]/outreach`<br>
Portal shells to `tools/outreach/clue-outreach` so strategy stays single-
sourced in Python.

## Tests

```sh
cd tools/outreach
python3 -m unittest discover -s tests -v
```

## Versioning

- Tool version: `VERSION` / `backend.lock.json`
- State schema: `clue.outreach.state.v1`
