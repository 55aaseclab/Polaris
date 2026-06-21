# Polaris Maturity Map

## Short Version

Polaris is not trying to become a copy of Coder.

Its shape is:

- `Workspace`
- `Isolation`
- `Agent Swarm`
- `Evolution`

Coder is the strongest comparison for the first three.

Hermes Agent is the more relevant comparison for the fourth.

So the right question is not:

- "Is Polaris the same product as Coder?"

The right question is:

- "How far is Polaris from a mature solution in each core direction?"

## Comparison Lens

Use these four directions:

1. `Workspace`
2. `Isolation`
3. `Agent Swarm`
4. `Evolution`

And compare Polaris against:

- `Coder` where Coder has a mature product answer
- `Hermes Agent` where the comparison is really about harness-level memory,
  review, retrieval, and self-improvement

## 1. Workspace

### Polaris Today

- Workspace is a first-class control-plane object.
- Saved spec is the source of truth.
- Generated manifests are outputs.
- Workspace profile and user profile are explicit.
- Lifecycle surface exists:
  `create`, `render`, `apply`, `start`, `stop`, `restart`, `rebuild`,
  `status`, `reconcile`, `logs`.
- Status, drift, and reconcile are control-plane concepts, not thin wrappers.

### Coder Today

Coder is ahead here.

- Templates are a mature workspace intent layer.
- Users and agents can provision repeatable workspaces directly from templates.
- Workspace governance, template controls, identity, auditability, and
  workspace policy are productized.
- Custom and external workspaces are also part of the platform story.

### Gap

Polaris has the right architecture, but Coder still has the stronger product.

Coder is ahead on:

- template ecosystem
- admin UX
- governance
- policy
- lifecycle polish
- onboarding and team operability

### Polaris Strength

Polaris is stronger on explicit state semantics:

- attachment model
- runtime contract
- clear separation between spec, generated output, and live observation

### TODO Toward Coder Maturity

- Build a real reusable template/profile registry, not just repo-managed specs.
- Add clearer workspace create flows for non-default backends.
- Add import/export and upgrade flows for workspace specs and profiles.
- Add first-class admin/operator views for workspace status, drift, and
  reconcile outcomes.
- Add policy hooks around allowed backends, allowed profiles, and allowed user
  profile mappings.
- Add audit-friendly lifecycle history for workspace creation, mutation, and
  reconcile actions.

## 2. Isolation

### Polaris Today

- Isolation is a core design concern.
- Polaris can target:
  - `pod`
  - `kubevirt-vm`
  - `docker`
- Pod and VM paths are treated as first-class runtime backends.
- The control plane reasons about runtime assembly and state inside those
  environments.

### Coder Today

Coder is mature on workspace provisioning and secure self-hosted environments,
but its product center of gravity is not "multi-backend isolation as a first
class abstraction" in the same explicit way Polaris models it.

Coder is stronger on:

- production deployment maturity
- admin controls
- enterprise governance
- broad infrastructure integration

### Gap

Polaris has the more explicit isolation substrate model.

Coder has the more mature production operational model.

### Polaris Strength

- Stronger conceptual split between workspace intent and backend realization
- Clearer runtime-state and attachment semantics across isolation surfaces
- Better foundation for saying "this workspace can move across pod/vm/docker
  while keeping the same logical contract"

### TODO Toward Coder Maturity

- Make backend parity boring:
  same lifecycle quality, same diagnostics, same docs, same recovery behavior.
- Add stronger backend capability matrices and preflight validation.
- Add operational SLO-level observability for backend provisioning and runtime
  failures.
- Add safer rollback and repair flows for backend-specific failures.
- Add platform install stories that are simpler than reading repo internals.

## 3. Agent Swarm

### Polaris Today

- Polaris intentionally does not provide a built-in coding harness.
- `Paseo` is the manager/orchestrator layer.
- `Codex` and `Claude` are external harnesses.
- Polaris assembles identity, SSH, runtime state, readiness, and manager
  surfaces around them.
- The current model is explicitly replaceable.

### Coder Today

Coder is ahead here as a product.

Its current docs and product direction show:

- built-in `Coder Agents`
- UI and API for delegating work
- template-driven provisioning for agent runs
- centralized identity and governance
- MCP and skill controls
- native self-hosted agent workflow story

### Gap

Coder is much more mature if the goal is:

- native agent UX
- built-in orchestration
- built-in governance
- productized multi-agent operator experience

Polaris is still an integration substrate here.

### Polaris Strength

Polaris is stronger if you care about:

- harness replaceability
- manager replaceability
- keeping the agent layer out of the control plane core

That is strategically valuable, but product maturity is still behind Coder.

### Where Hermes Enters

Hermes is relevant here as a harness reference rather than a workspace platform
reference.

It is useful for:

- agent memory
- evolving skills
- autonomous review/feedback loops
- persistent harness behavior

If Coder is the comparison for "native agent platform", Hermes is the
comparison for "what a mature harness can do once it has a real memory and
review loop".

### TODO Toward Coder Maturity

- Define a real manager contract surface beyond today's Paseo-first reality.
- Add first-class multi-agent orchestration concepts instead of only external
  runtime bootstrapping.
- Add control-plane views for manager sessions, task history, and handoffs.
- Add operator controls for allowed harnesses, allowed skills, and allowed MCP
  surfaces.
- Add swarm coordination primitives:
  task graph, delegation, review, merge, and attribution.
- Add stronger identity and audit semantics for "who did what" across agents.

## 4. Evolution

### Polaris Today

Polaris now has a real evolution kernel rather than only an aspiration.

Its current loop is:

1. capture execution signals
2. review them into typed lessons
3. curate those lessons over time
4. retrieve active lessons into future runs

That loop is manager-agnostic at the control-plane boundary.

Today Polaris already has:

- manager-generic contract scaffolding
- an evolution store
- typed artifacts
- reviewer / retriever / curator modules
- automatic lifecycle event capture
- bootstrap context generation and runtime injection
- workspace-scoped and user-linked evolution semantics

This is meaningful progress.

### Hermes Today

Hermes is the stronger comparison here.

Its public shape emphasizes:

- agent-curated memory
- autonomous skill creation
- skills that improve over time
- session recall
- periodic review/nudges
- persistent harness behavior

That is much closer to "mature evolution harness" territory than Coder's
current product story.

### Gap

Polaris has the kernel and the loop shape.

Hermes has the stronger harness-level closed learning loop.

Polaris is still earlier on:

- transcript fidelity and richer runtime capture
- retrieval influence in real runs
- curator authority
- promotion/decay policy
- explanation and trust surfaces

### Polaris Strength

Polaris may end up stronger on architectural placement:

- evolution lives at the control-plane boundary
- not buried inside one harness
- not tied to one manager forever
- separated from identity state and private harness config

That is potentially better than a harness-only design, but it still needs to
prove itself in real use.

### TODO Toward Hermes Maturity

- Make retrieval actually influence future runs in a visible, debuggable way.
- Add curator promotion, merge, suppression, and decay policies with operator
  visibility.
- Add artifact explainability:
  why this lesson exists, why it was retrieved, why it was suppressed.
- Separate workspace-local playbooks from user-linked preferences cleanly in UX
  and policy.
- Add background and scheduled review flows so evolution is not only invoked by
  tests or explicit hooks.
- Add safety around hallucinated lessons and stale knowledge.
- Add deeper manager-native transcript ingestion without making the manager the
  source of truth.

## Direction-by-Direction Scorecard

| Direction | Polaris Today | Stronger Comparator | Polaris Advantage | Main Gap |
|---|---|---|---|---|
| Workspace | credible control plane | `Coder` | explicit state semantics | product maturity, governance, templates |
| Isolation | strong architecture | mixed | clearer isolation abstraction | operational maturity and parity |
| Agent Swarm | external integration layer | `Coder` | replaceability | native orchestration product |
| Evolution | real kernel, early closed loop | `Hermes` | control-plane placement | deeper closed-loop maturity |

## Most Important Reality Check

Polaris should move toward mature solutions, not toward feature mimicry.

That means:

- follow `Coder` where the problem is workspace platform maturity
- follow `Hermes` where the problem is harness memory, review, retrieval, and
  evolution maturity
- keep Polaris' own architectural advantage:
  explicit state semantics plus a replaceable agent layer

## Practical Conclusion

The strongest current framing is:

- `Coder` is the benchmark for `Workspace`, much of `Isolation`, and native
  `Agent Swarm` product maturity.
- `Hermes Agent` is the benchmark for `Evolution` maturity.
- `Polaris` should not collapse into either one.

It should converge toward:

```text
Coder-grade workspace platform maturity
+ Hermes-grade evolution maturity
+ Polaris-native explicit state and replaceable manager architecture
```
