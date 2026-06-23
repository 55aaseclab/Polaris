# Workspace Maturity

## Short Version

For `Workspace`, the strongest comparison is `Coder`.

The question is not whether Polaris is the same product as Coder.
The question is how far Polaris is from a mature workspace platform.

## Polaris Today

- Workspace is a first-class control-plane object.
- Saved spec is the source of truth.
- Generated manifests are outputs.
- Workspace profile and user profile are explicit.
- Lifecycle surface exists:
  `create`, `render`, `apply`, `start`, `stop`, `restart`, `rebuild`,
  `status`, `reconcile`, `logs`.
- Status, drift, and reconcile are control-plane concepts, not thin wrappers.

## Coder Today

Coder is ahead here.

- Templates are a mature workspace intent layer.
- Users and agents can provision repeatable workspaces directly from templates.
- Workspace governance, template controls, identity, auditability, and
  workspace policy are productized.
- Custom and external workspaces are also part of the platform story.

## Gap

Polaris has the right architecture, but Coder still has the stronger product.

Coder is ahead on:

- template ecosystem
- admin UX
- governance
- policy
- lifecycle polish
- onboarding and team operability

## Polaris Strength

Polaris is stronger on explicit state semantics:

- attachment model
- runtime contract
- clear separation between spec, generated output, and live observation

## TODO Toward Coder Maturity

- Build a real reusable template/profile registry, not just repo-managed specs.
- Add clearer workspace create flows for non-default backends.
- Add import/export and upgrade flows for workspace specs and profiles.
- Add first-class admin/operator views for workspace status, drift, and
  reconcile outcomes.
- Add policy hooks around allowed backends, allowed profiles, and allowed user
  profile mappings.
- Add audit-friendly lifecycle history for workspace creation, mutation, and
  reconcile actions.
