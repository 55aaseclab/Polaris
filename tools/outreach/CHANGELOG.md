# Changelog

## 0.1.0 - 2026-07-23

- Initial `clue-outreach` stateful outreach tool.
- Import `outreach_ready_records` into durable lead state.
- Engagement lifecycle: draft → approve → send (dry-run or SMTP).
- Multi-channel contact points and manual outcome logging.
- Strategy engine: next-task queue, wait windows, suppressions.
- CLI: import, status, next, draft, approve, reject, send, log,
  suppress, reply, bounce, tick.
