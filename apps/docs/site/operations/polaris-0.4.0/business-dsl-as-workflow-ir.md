# Business DSL As Workflow IR

Status: implemented as the Domain Pack declaration and execution contract for
the Polaris 0.4.0 Phase 3-6 slice. The DSL describes reusable business work;
Polaris owns admission, Vault binding, policy, run state, receipts, and
artifacts. AI-assisted workflow generation is not implemented.

The workflow package also contains a separately gated `v0.4-trial` language
surface. It is an experiment for bounded control graphs, not a replacement for
the v0.3 flow language. A source file must explicitly declare
`dsl version "0.4-trial"` to use `trial`, `nodes`, `edges`, retry budgets, or
feedback routing.

Related:

- [Polaris 0.4.0 overview](./)
- [WorkEnvelope and workflow plan](./work-envelope-and-workflow-plan.md)
- [Dynamic workflow runtime](./dynamic-workflow-runtime.md)
- [Vault Management](../../polaris/vault-management.md)

## The Boundary

A Domain Pack is outside every Vault. It is immutable DSL source plus a
manifest and content digest. A workflow defined in that pack is reusable
across Vaults; the run is the object that selects one Vault and receives a
capability lease.

```text
Domain Pack (.ord) outside Vault
    -> parse / resolve imports / validate / compile
    -> Portal displays pack and internal flows
    -> Polaris pins id + version + digest for a run
    -> run receives tenant + Vault capability lease
    -> Host invokes workflow-declared FFI calls
```

The DSL never contains a shell command, HTTP URL, executable path, credential,
tenant authority, or workspace root. private surface workflow files remain surface
assets; they are not the Polaris definition authority.

## Three Worlds

| World | DSL constructs | Polaris contract |
| --- | --- | --- |
| Meaning | `entity`, `enum`, `require`, `transition`, `emit`, `module` | Work semantics and state projection |
| Computation | `input`, `uses`, step `output`, flow `output`, `pipeline` | Typed data and deterministic program execution |
| FFI | `port`, `call`, `needs`, `import`, version pin | Host registry, capability policy, RPC receipt |

`port` is a contract, not an implementation. A step's `call` names the port
that the Host must resolve. `needs` declares the flow's required capability
ports. The compiler preserves the symbol and version; it does not inline a
CLI or tool path.

## Domain Pack And Flow Mapping

```text
domain pack             -> immutable installed pack
module                  -> Portal workflow group / role grouping
flow                    -> selectable internal workflow
entity + transition     -> deterministic document state semantics
input                   -> Portal form schema and run input
steps.uses/output       -> typed dataflow in the compiled Program
needs                   -> capability declaration checked by Host
port + version          -> generic FFI/RPC call contract
call Port@version       -> one effect invocation and receipt
```

The Portal first selects a Domain Pack as the work scene. It then displays the
complete list of flows inside that pack, grouped by the pack's module metadata.
The Portal does not contain domain IDs, flow IDs, role names, or special-case
execution code.

## FFI Calls Belong To Workflows

Calls are declared in a flow and are part of its immutable definition. They
are not configured as a separate Portal-side tool list:

```text
port ReviewPlan version "1.0.0" {
  builtin manual.review
  in { title: String, instructions: String, context: String? }
  out { approved: Boolean, reviewId: ID, notes: String? }
  effect human
}

flow ReviewBrief title "Review brief" create {
  needs { ReviewPlan }
  input { subject: String required }
  steps {
    review "Manual review" {
      uses { subject }
      call ReviewPlan
      output { approved: Boolean, reviewId: ID }
    }
  }
  output { approved: Boolean from approved, reviewId: ID from reviewId }
  ui { layout form primary "Submit" }
}
```

The example is a declaration only. The Domain Pack supplies business labels
and fields. Polaris supplies the generic built-in interface, approval state,
lease check, receipt, and Portal card. The mock Host returns deterministic
synthetic values and a `waiting` receipt; it does not perform a real review.

## First-Party Example

The current minimum business domain is
`apps/polaris/domain-packs/vault-knowledge-health/main.ord`. It defines
`VaultKnowledgeHealth@1.0.0` and the `ReviewKnowledgeHealth` flow. That flow
declares `ArtifactMetadata@1.0.0`, which Polaris maps to the Common tool
`vault.artifact.metadata.read`.

Ordinary Portal runs still execute this flow with mock policy. Live metadata
reads require the separate Polaris operator admission path, both live flags,
and deployment evidence.

## Generic RPC Contract

The RPC wire contract is exported by `packages/polaris-workflow`:

```ts
type FfiRpcRequest = {
  protocolVersion: "1.0";
  requestId: string;
  idempotencyKey: string;
  runId: string;
  tenantId: string;
  vaultId: string;
  pack: { id: string; version: string; digest: string };
  capabilityLease: {
    id: string;
    packDigest: string;
    vaultId: string;
    expiresAt: string;
  };
  call: {
    port: string;
    version: string;
    effect: string;
    builtin?: string;
  };
  input: Record<string, string | number | boolean | undefined>;
  mode: "mock" | "live";
  traceId?: string;
};
```

The response contains the same request ID, status, output, receipt, and a
bounded error when denied or failed. `checkFfiAdmission` rejects a missing
pack digest, missing lease, pack/lease digest mismatch, Vault mismatch, or
expired lease. This validator is required for a future live or AI Host too;
the mock Host is not allowed to weaken it.

Every call produces an effect receipt with request ID, port/version, effect,
status, timestamps, and output digest. Polaris persists the receipt using the
request ID as the idempotency boundary.

## Built-in Interfaces

Built-ins are generic Polaris interfaces, not domain-specific tool bodies:

| Built-in | Effect | Domain Pack responsibility | Polaris responsibility |
| --- | --- | --- | --- |
| `manual.review@1.0.0` | human | Declare port, fields, labels, and call location | Approval request, lease check, waiting/resume state, receipt |

Additional built-ins may be added to the registry only with a versioned input
and output contract, risk classification, policy requirement, receipt model,
and mock implementation. A pack cannot bind a built-in to an arbitrary
executable or endpoint.

## Static Guarantees

Pack installation and run admission enforce these guarantees:

- the DSL parses and validates before installation;
- imports resolve only to installed compatible packs;
- flow calls resolve to known port symbols and versions;
- `needs` is checked against the Host port table;
- required inputs and deterministic guards are checked before a run advances;
- a run loads exactly the installed bytes named by its digest; and
- no definition can widen tenant, Vault, capability, or policy scope.

The current language deliberately keeps dynamic behavior small. Waits,
parallel branches, compensations, and plan revisions belong to the durable
runtime contract, not to ad hoc Agent-generated source. A future extension
must be versioned and validated before it can be enabled.

The v0.4-trial package extension supplies the bounded subset needed to model a
CVE-Genie-style graph: conditional edges, feedback references, node-local
attempts, transition limits, timeout/cost/action budgets, waiting/resume,
cancel, receipt checkpoints, and bounded artifact projections. It exposes a
`TrialStateStore` interface so Polaris can provide durable storage. The current
fixture uses only a deterministic Host and is not connected to the production
workflow worker.

## Runtime Mapping

```text
parse -> resolve imports -> validate -> compile Program
                                      |
                                      v
                             Program.run(flow, input)
                                      |
                                      v
                         FfiHost.invoke(port, version, input)
                                      |
                                      v
                         RPC request + capability lease
                                      |
                                      v
                      receipt -> event -> artifact projection
```

The current execution path uses a deterministic `MockWorkflowRpcHost` and a
fresh in-memory `DocStore` per run. The control store remains the source of
run, event, receipt, and artifact state. No Domain Pack code is loaded into a
Vault and no package manager is invoked by a workflow run.

## Implementation Locations

| Component | Where | Must not do |
| --- | --- | --- |
| DSL declarations | Domain Pack repository | Own scheduling, identity, or Vault paths |
| Parser/compiler/RPC | `packages/polaris-workflow` | Call live external tools directly |
| Pack installation and digest pin | Polaris app | Accept mutable `latest` fallback |
| Built-in registry and mock Host | Polaris app/package | Implement pack-specific business policy |
| Workflow queue and state | Polaris app/control store | Move authority to Portal or private surface |
| Surface presentation | Paseo/private surface packages | Publish direct ports or schedule runs |
| Live execution adapter | Future Polaris/Vault boundary | Bypass pack pin or capability lease |

## Suggestion And AI Boundary

Phase 6 can produce a deterministic `suggested` draft from a successful run.
The draft includes the source run, event evidence, pack digest, flow, and
receipt references. It is not a published Domain Pack and cannot execute.

AI-assisted workflow generation is postponed. When it is added, the model may
propose a DSL fragment or AST, but Polaris must still:

1. validate syntax, imports, port versions, dataflow, and risk;
2. attach source event evidence and a tenant scope;
3. run a no-side-effect dry run;
4. require human review for publication and enabling; and
5. issue a new immutable pack/definition version and fresh run lease.

Model confidence is never a capability grant.

## Role Boundary

The DSL does not hardcode role names. A pack may provide module/group metadata
for role-specific flow catalogs, while Polaris decides what a current user can
see, suggest, approve, or execute:

```text
observer   -> read pack and scoped evidence
proposer   -> create a disabled draft
approver   -> approve or reject a draft/run action
executor   -> run an already pinned definition with a current lease
reconciler -> inspect receipts and failures
```

Membership does not imply execution. All four capabilities are independently
checked by Polaris policy.

## Verification

The DSL and RPC contract is covered by package tests for parsing, built-in
resolution, deterministic output, and admission denial. Polaris tests cover
pack digest mismatch, atomic envelope/lease/event creation, event replay,
worker recovery, manual review approval, cancellation, retry, tenant
isolation, receipts, artifact digest, and disabled suggestions.

The contract checks are:

```text
pnpm --filter polaris-workflow run typecheck
pnpm --filter polaris-workflow test
pnpm --filter polaris exec tsc --noEmit
pnpm --filter polaris exec tsx --test tests/polaris-workflow-control.test.ts
```

Passing these checks proves the declaration and control boundaries. It does
not prove a live tool, Agent, private surface mutation, or external side effect.
