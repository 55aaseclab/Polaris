## 1. Core Memory Model

- [x] 1.1 Replace lesson-oriented semantics with workspace memory and user
  memory semantics
- [x] 1.2 Define bounded local `MEMORY.md` and `USER.md` file layouts
- [x] 1.3 Define structured supporting state for memory operations, pending
  approvals, and curation metadata

## 2. Memory Operations

- [x] 2.1 Add explicit memory operations with `add`, `replace`, and `remove`
  semantics
- [x] 2.2 Add source attribution and reasons for every persisted memory change
- [x] 2.3 Add write policy modes for automatic writes and staged approval

## 3. Background Review

- [x] 3.1 Update runtime review to derive memory operations instead of lessons
  or skills
- [x] 3.2 Add conservative policy rules for when review proposes memory writes
- [x] 3.3 Add pending-review and approval flows for memory updates

## 4. Session Use

- [x] 4.1 Assemble frozen memory snapshots at session start
- [x] 4.2 Separate workspace memory from user memory in snapshot assembly
- [x] 4.3 Ensure harness adapters consume snapshots without manager-specific
  prompt mutation hacks

## 5. Optional Provider Integration

- [x] 5.1 Define an optional memory-provider contract for retrieval and sync
- [x] 5.2 Support provider-assisted pre-run retrieval
- [x] 5.3 Support post-run or session-end provider sync of approved memories

## 6. Verification And Documentation

- [x] 6.1 Add tests for memory operations, approval policy, and snapshot
  assembly
- [x] 6.2 Add tests for background review producing memory updates
- [x] 6.3 Update evolution documentation to describe the memory model, file
  scopes, review policy, and provider contract
