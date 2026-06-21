## 1. Direct Attachment Schema

- [x] 1.1 Define the direct saved-spec shape for `workspace-data`, `workspace-runtime-state`, `user-identity-state`, `user-ssh-state`, and `ephemeral-runtime`
- [x] 1.2 Extend the TypeScript workspace config loader to parse the direct attachment schema
- [x] 1.3 Make direct attachment declarations authoritative when present
- [x] 1.4 Keep a bounded compatibility translation path only when direct attachment declarations are absent

## 2. Validation And Backend Inputs

- [x] 2.1 Validate attachment scope, sharing, and durability at config-load time
- [x] 2.2 Update backend drivers to consume direct attachment declarations as the primary input path
- [x] 2.3 Ensure runtime path assembly still presents the expected in-workspace paths while using the direct attachment schema underneath
- [x] 2.4 Keep the docker legacy backend aligned with the direct attachment vocabulary even if its realization remains transitional

## 3. Spec Migration

- [x] 3.1 Migrate the repo-managed workspace specs under `config/specs/**` to the direct attachment schema
- [x] 3.2 Mark legacy path-centric persistence fields as compatibility-only in code and validation messages
- [x] 3.3 Update generated manifest/debug metadata where helpful so operators can see attachment-driven realization clearly
- [x] 3.4 Verify that migrated specs preserve the current attachment semantics for `paseo`, `codex`, `claude`, SSH, and ephemeral runtime state

## 4. Docs And Verification

- [x] 4.1 Update `docs/agentctl/README.md` and `docs/agentctl/runtime-layout.md` to teach the direct attachment config model as the primary one
- [x] 4.2 Add or update tests for direct attachment config parsing and precedence over legacy fields
- [x] 4.3 Add or update tests for migrated repo-managed specs across pod, kubevirt-vm, and docker paths
- [x] 4.4 Validate the direct attachment schema through TypeScript typecheck, test suite, and representative `status`/`render` flows
