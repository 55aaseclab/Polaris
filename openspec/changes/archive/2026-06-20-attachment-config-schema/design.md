## Context

Polaris now has the correct internal persistence model: durable and ephemeral state are classified through attachment classes instead of through a persisted runtime home. However, the user-facing config model has not caught up. Current workspace specs still describe an older path-centric and storage-centric shape, and the control plane translates that legacy config into attachment semantics during load.

That translation layer was the right transition step, but it is now the main architectural mismatch in the system:

- the platform model is attachment-based
- the saved config model is still largely path-based
- backend drivers consume the right semantics, but only after translation

This keeps the external contract behind the internal model and leaves room for drift between what users declare and what the platform actually means.

## Goals / Non-Goals

**Goals:**

- Make attachment classes the first-class user-facing config schema.
- Ensure workspace specs directly express `workspace-data`, `workspace-runtime-state`, `user-identity-state`, `user-ssh-state`, and `ephemeral-runtime`.
- Reduce the legacy translation layer from “main config path” to “bounded migration bridge.”
- Make backend drivers consume the direct attachment schema rather than relying on legacy persistence fields as the authoritative source.
- Align docs, validation, and runtime reporting with the direct attachment schema.

**Non-Goals:**

- Removing compatibility immediately for every legacy config file without a migration story.
- Redesigning the attachment semantics themselves; this change is about config expression, not changing the attachment taxonomy.
- Solving every future secret-management or identity-rotation workflow here.
- Renaming every historic artifact, archived OpenSpec change, or legacy generated file in the repository.

## Decisions

### Decision: Attachment classes become the direct config contract

Workspace specs will directly declare attachments instead of inferring them from broad fields such as `persist_state`, `storage_claim_name`, or home-oriented durable path lists.

Rationale:

- This makes the user-facing contract match the real platform model.
- It removes ambiguity around which state is workspace-scoped versus user-scoped.

Alternatives considered:

- Keep the translation layer indefinitely. Rejected because it leaves the external contract behind the architecture and makes the model harder to learn and validate.

### Decision: Keep a bounded compatibility layer for legacy specs during migration

Legacy path-centric config remains readable for a migration period, but it is explicitly treated as compatibility input rather than the main schema.

Rationale:

- Existing configs and workflows need a migration path.
- A bounded bridge is safer than a flag day cutover.

Alternatives considered:

- Break all legacy specs immediately. Rejected because it creates unnecessary migration risk and operational disruption.

### Decision: Backend drivers consume attachment config directly

Backend drivers should operate on the direct attachment schema, not on translated home-path assumptions.

Rationale:

- This keeps the attachment model authoritative.
- It reduces backend-specific reliance on historical path conventions.

Alternatives considered:

- Continue translating into a hidden intermediate shape before every backend. Rejected because that preserves legacy semantics at the wrong boundary.

### Decision: Validation moves up to schema-level attachment rules

Validation will focus on attachment scope, sharing, durability, and required class presence before backend realization.

Rationale:

- Attachment validity is more fundamental than path validity.
- It gives users faster, clearer feedback about misclassified state.

Alternatives considered:

- Keep validating mostly runtime paths. Rejected because paths are no longer the primary persistence contract.

### Decision: Docs and examples describe the attachment schema first

Documentation will teach the direct attachment config model as the normal way to describe persistence, while legacy config is documented only as migration compatibility.

Rationale:

- Users should learn the actual platform model, not the transitional one.
- This reduces cognitive overhead and future cleanup work.

Alternatives considered:

- Continue presenting legacy and new config forms as equal. Rejected because that prolongs ambiguity.

## Risks / Trade-offs

- [Two config styles may coexist during migration] → Mitigation: make one clearly primary and the other clearly compatibility-only, with validation and docs reflecting that distinction.
- [Existing specs may rely on old implicit behavior] → Mitigation: keep a compatibility path long enough to migrate them deliberately and add focused tests for translation parity.
- [Backend code may still assume old path conventions] → Mitigation: require drivers to consume attachment classes directly and test their runtime path assembly separately.
- [Users may over-specify physical mount details in logical config] → Mitigation: keep the direct config schema focused on attachment semantics, not backend-specific mount implementation.
- [Config churn may temporarily increase] → Mitigation: provide clear examples and a narrow migration pattern for current saved specs.

## Migration Plan

1. Introduce direct attachment schema fields in the saved workspace spec model.
2. Teach the loader to prefer direct attachment declarations over legacy persistence fields.
3. Retain a compatibility translation path only when direct attachment declarations are absent.
4. Update backend drivers and tests so the direct attachment schema is the primary path.
5. Update docs and examples to present the attachment schema as the standard configuration format.
6. Migrate existing repo-managed specs to the new schema.
7. Later, once migration is stable, remove or sharply constrain the legacy compatibility path.

## Open Questions

- What is the exact YAML shape for attachment declarations in saved specs?
- Which legacy fields should remain temporarily supported, and which should be deprecated immediately?
- Should attachment declarations support backend-specific overrides inline, or should backend-specific realization stay entirely outside the saved attachment schema?
- When migration is complete, should generated manifests embed attachment-origin metadata for debugging and auditability?
