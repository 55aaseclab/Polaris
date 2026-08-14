export const POLARIS_TOOL_PUBLISHER_ID = "jianxiaoyi";
export const POLARIS_TOOL_PUBLISHER_NAME = "Jianxiaoyi";
export const POLARIS_TOOL_PORTAL_BASE_PATH = "/tools";

export const POLARIS_MANUAL_REVIEW_TOOL_ID = "manual.review";
export const POLARIS_VAULT_ARTIFACT_METADATA_TOOL_ID = "vault.artifact.metadata.read";

export type PolarisToolEffect = "pure" | "read" | "write" | "ffi" | "human" | "time";
export type PolarisToolRisk = "read" | "workspace" | "external" | "human";
export type PolarisToolAdapter = "polaris.human" | "polaris.projection";
export type PolarisToolExecutionMode = "mock-only" | "disabled-live-boundary";
export type PolarisToolCredentialPolicy = "none" | "polaris-managed";
export type PolarisToolGate =
  | "receipt-reconciliation"
  | "budget"
  | "kill-switch"
  | "audit"
  | "rollback"
  | "deployment-evidence";

export const REQUIRED_POLARIS_LIVE_TOOL_GATES = [
  "receipt-reconciliation",
  "budget",
  "kill-switch",
  "audit",
  "rollback",
  "deployment-evidence",
] as const satisfies readonly PolarisToolGate[];

export interface PolarisToolFieldSchema {
  readonly type: string;
  readonly required?: boolean;
  readonly description: string;
}

export interface PolarisToolManifest {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly version: 1;
  readonly publisher: {
    readonly id: typeof POLARIS_TOOL_PUBLISHER_ID;
    readonly name: typeof POLARIS_TOOL_PUBLISHER_NAME;
    readonly firstParty: true;
  };
  readonly category: "workflow" | "vault";
  readonly tags: readonly string[];
  readonly workflow: {
    readonly port: string;
    readonly portVersion: string;
    readonly effect: PolarisToolEffect;
    readonly builtin?: string;
    readonly actionId: string;
    readonly risk: PolarisToolRisk;
    readonly adapter: PolarisToolAdapter;
    readonly executionMode: PolarisToolExecutionMode;
    readonly liveEnabled: false;
    readonly requiredGates: readonly PolarisToolGate[];
  };
  readonly schema: {
    readonly input: Readonly<Record<string, PolarisToolFieldSchema>>;
    readonly output: Readonly<Record<string, PolarisToolFieldSchema>>;
  };
  readonly approval: {
    readonly required: boolean;
    readonly owner: "polaris";
    readonly policy: string;
  };
  readonly credentials: {
    readonly policy: PolarisToolCredentialPolicy;
    readonly owner: "polaris";
    readonly notes: string;
  };
  readonly receipts: {
    readonly owner: "polaris";
    readonly idempotency: string;
    readonly evidence: readonly string[];
  };
  readonly surfaces: {
    readonly publicCatalog: true;
  };
  readonly examples: readonly {
    readonly title: string;
    readonly input: Readonly<Record<string, string | number | boolean>>;
    readonly workflowSnippet: string;
  }[];
}

export interface PolarisWorkflowActionCatalogEntry {
  readonly id: string;
  readonly version: 1;
  readonly port: string;
  readonly portVersion: string;
  readonly effect: PolarisToolEffect;
  readonly builtin?: string;
  readonly risk: PolarisToolRisk;
  readonly adapter: PolarisToolAdapter;
  readonly liveEnabled: false;
  readonly requiredGates: readonly PolarisToolGate[];
  readonly description: string;
}

export type PolarisToolPortalLiveState =
  | "mock-only"
  | "disabled-live-boundary";

export type PolarisToolPortalScope = "common" | "domain-pack";

export interface PolarisToolPortalDomainPackRef {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}

export interface PolarisToolPortalCallRef {
  readonly id: string;
  readonly port: string;
  readonly version: string;
  readonly effect: PolarisToolEffect;
  readonly builtin?: string;
  readonly mappedToolId?: string;
  readonly unresolved: boolean;
}

export interface PolarisToolPortalFieldRef {
  readonly id: string;
  readonly label?: string;
  readonly type?: string;
  readonly placeholder?: string;
  readonly required: boolean;
}

export interface PolarisDomainPackToolFlowProjection {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly approvalRequired: boolean;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly port: string;
    readonly version: string;
    readonly effect: PolarisToolEffect;
    readonly builtin?: string;
    readonly unresolved: boolean;
  }[];
  readonly fields: readonly PolarisToolPortalFieldRef[];
}

export interface PolarisDomainPackToolProjection {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly digest: string;
  readonly flows: readonly PolarisDomainPackToolFlowProjection[];
}

export interface PolarisToolPortalCatalogRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly scope: PolarisToolPortalScope;
  readonly scopeLabel: string;
  readonly domainPack?: PolarisToolPortalDomainPackRef;
  readonly fields?: readonly PolarisToolPortalFieldRef[];
  readonly toolCalls: readonly PolarisToolPortalCallRef[];
  readonly category: PolarisToolManifest["category"];
  readonly tags: readonly string[];
  readonly publisherName: string;
  readonly firstParty: true;
  readonly effect: PolarisToolManifest["workflow"]["effect"];
  readonly risk: PolarisToolManifest["workflow"]["risk"];
  readonly liveState: PolarisToolPortalLiveState;
  readonly href: string;
}

export interface PolarisToolPortalDetail extends PolarisToolPortalCatalogRow {
  readonly description: string;
  readonly version: 1;
  readonly actionId: string;
  readonly port: string;
  readonly portVersion: string;
  readonly adapter: PolarisToolManifest["workflow"]["adapter"];
  readonly approvalRequired: boolean;
  readonly approvalPolicy: string;
  readonly credentialPolicy: PolarisToolManifest["credentials"]["policy"];
  readonly credentialNotes: string;
  readonly receipts: PolarisToolManifest["receipts"];
  readonly requiredGates: readonly string[];
  readonly inputSchema: PolarisToolManifest["schema"]["input"];
  readonly outputSchema: PolarisToolManifest["schema"]["output"];
  readonly examples: PolarisToolManifest["examples"];
}

export interface PolarisToolMockInvocation {
  readonly toolId: string;
  readonly requestId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly now?: Date;
}

export interface PolarisToolMockResult {
  readonly toolId: string;
  readonly requestId: string;
  readonly status: "mocked" | "waiting";
  readonly output: Readonly<Record<string, unknown>>;
  readonly receipt: {
    readonly id: string;
    readonly owner: "polaris";
    readonly evidence: readonly string[];
  };
}

const publisher = {
  id: POLARIS_TOOL_PUBLISHER_ID,
  name: POLARIS_TOOL_PUBLISHER_NAME,
  firstParty: true,
} as const;

const manualReviewManifest = {
  id: POLARIS_MANUAL_REVIEW_TOOL_ID,
  slug: "manual-review",
  name: "Manual Review",
  summary: "Routes a workflow step to a Polaris-owned human approval record.",
  description:
    "Manual Review is the first-party approval interface used by workflow packs. "
    + "It records a waiting state and resumes only through Polaris workflow state.",
  version: 1,
  publisher,
  category: "workflow",
  tags: ["approval", "workflow", "human"],
  workflow: {
    port: "manual.review",
    portVersion: "1.0.0",
    effect: "human",
    builtin: "manual.review",
    actionId: POLARIS_MANUAL_REVIEW_TOOL_ID,
    risk: "human",
    adapter: "polaris.human",
    executionMode: "mock-only",
    liveEnabled: false,
    requiredGates: REQUIRED_POLARIS_LIVE_TOOL_GATES,
  },
  schema: {
    input: {
      title: {
        type: "String",
        required: true,
        description: "Review title shown in the Polaris work deck.",
      },
      instructions: {
        type: "String",
        required: true,
        description: "Human-readable approval instructions.",
      },
      context: {
        type: "String",
        description: "Optional workflow context for the reviewer.",
      },
    },
    output: {
      approved: {
        type: "Boolean",
        required: true,
        description: "Whether Polaris recorded an approval.",
      },
      reviewId: {
        type: "ID",
        required: true,
        description: "Synthetic or durable Polaris review identifier.",
      },
      notes: {
        type: "String",
        description: "Optional reviewer notes.",
      },
    },
  },
  approval: {
    required: true,
    owner: "polaris",
    policy: "Polaris stores the waiting run and validates the approving actor.",
  },
  credentials: {
    policy: "none",
    owner: "polaris",
    notes: "No external credential is needed.",
  },
  receipts: {
    owner: "polaris",
    idempotency: "requestId",
    evidence: ["workflow-run", "approval-event", "effect-receipt"],
  },
  surfaces: {
    publicCatalog: true,
  },
  examples: [{
    title: "Approve a generated plan",
    input: {
      title: "Review plan",
      instructions: "Check the proposed operations plan before continuing.",
    },
    workflowSnippet:
      'port ReviewPlan version "1.0.0" {\n'
      + "  builtin manual.review\n"
      + "  in { title: String, instructions: String }\n"
      + "  out { approved: Boolean, reviewId: ID }\n"
      + "  effect human\n"
      + "}",
  }],
} as const satisfies PolarisToolManifest;

const vaultArtifactMetadataManifest = {
  id: POLARIS_VAULT_ARTIFACT_METADATA_TOOL_ID,
  slug: "vault-artifact-metadata-read",
  name: "Vault Artifact Metadata Read",
  summary: "Reads bounded artifact metadata from Polaris-owned Vault status.",
  description:
    "Vault Artifact Metadata Read is the first disabled live-tool pilot. It "
    + "can summarize cached artifact metadata only after Polaris admission, "
    + "receipt, audit, budget, kill-switch, rollback, and deployment gates pass.",
  version: 1,
  publisher,
  category: "vault",
  tags: ["vault", "metadata", "read-only"],
  workflow: {
    port: "ArtifactMetadata",
    portVersion: "1.0.0",
    effect: "read",
    actionId: POLARIS_VAULT_ARTIFACT_METADATA_TOOL_ID,
    risk: "read",
    adapter: "polaris.projection",
    executionMode: "disabled-live-boundary",
    liveEnabled: false,
    requiredGates: REQUIRED_POLARIS_LIVE_TOOL_GATES,
  },
  schema: {
    input: {
      artifactScope: {
        type: "String",
        description: "Optional logical artifact scope. Mock mode ignores it.",
      },
    },
    output: {
      artifactCount: {
        type: "Number",
        required: true,
        description: "Number of artifacts in the bounded projection.",
      },
      latestTitles: {
        type: "String[]",
        required: true,
        description: "At most five recent artifact titles.",
      },
      pendingMemoryChanges: {
        type: "Number",
        required: true,
        description: "Pending memory-change count from cached Vault status.",
      },
    },
  },
  approval: {
    required: false,
    owner: "polaris",
    policy: "Polaris must admit the read and persist receipt/audit evidence.",
  },
  credentials: {
    policy: "polaris-managed",
    owner: "polaris",
    notes: "The live executor reads only Polaris-owned Vault metadata.",
  },
  receipts: {
    owner: "polaris",
    idempotency: "requestId",
    evidence: ["workflow-run", "effect-receipt", "audit-event"],
  },
  surfaces: {
    publicCatalog: true,
  },
  examples: [{
    title: "Summarize cached artifacts",
    input: {
      artifactScope: "latest",
    },
    workflowSnippet:
      'port ArtifactMetadata version "1.0.0" {\n'
      + "  in { artifactScope: String? }\n"
      + "  out { artifactCount: Number, latestTitles: String }\n"
      + "  effect read\n"
      + "}",
  }],
} as const satisfies PolarisToolManifest;

const TOOL_MANIFESTS = [
  manualReviewManifest,
  vaultArtifactMetadataManifest,
] as const satisfies readonly PolarisToolManifest[];

export function listPolarisToolManifests(): readonly PolarisToolManifest[] {
  return TOOL_MANIFESTS;
}

export function findPolarisToolManifest(
  idOrSlug: string,
): PolarisToolManifest | undefined {
  const normalized = idOrSlug.trim();
  if (!normalized) return undefined;
  return TOOL_MANIFESTS.find((tool) =>
    tool.id === normalized || tool.slug === normalized
  );
}

export function listPolarisWorkflowActionCatalogEntries():
readonly PolarisWorkflowActionCatalogEntry[] {
  return TOOL_MANIFESTS.map((tool) => {
    const workflow: PolarisToolManifest["workflow"] = tool.workflow;
    return {
      id: workflow.actionId,
      version: tool.version,
      port: workflow.port,
      portVersion: workflow.portVersion,
      effect: workflow.effect,
      ...(workflow.builtin ? { builtin: workflow.builtin } : {}),
      risk: workflow.risk,
      adapter: workflow.adapter,
      liveEnabled: workflow.liveEnabled,
      requiredGates: workflow.requiredGates,
      description: tool.summary,
    };
  });
}

export function listPolarisDomainPackToolPortalCatalogRows(
  packs: readonly PolarisDomainPackToolProjection[],
  basePath = POLARIS_TOOL_PORTAL_BASE_PATH,
): readonly PolarisToolPortalCatalogRow[] {
  return packs.flatMap((pack) =>
    pack.flows.map((flow) => {
      const slug = domainPackToolSlug(pack.id, flow.id);
      return {
        id: domainPackToolId(pack.id, flow.id),
        slug,
        name: flow.title,
        summary: flow.summary,
        scope: "domain-pack",
        scopeLabel: pack.title,
        domainPack: domainPackRef(pack),
        fields: flow.fields,
        toolCalls: domainPackFlowToolCalls(flow),
        category: "workflow",
        tags: ["domain-pack", pack.id],
        publisherName: POLARIS_TOOL_PUBLISHER_NAME,
        firstParty: true,
        effect: flow.approvalRequired ? "human" : "read",
        risk: flow.approvalRequired ? "human" : "read",
        liveState: "mock-only",
        href: polarisToolPortalPath(`/packs/${pack.id}/${slug}`, basePath),
      } satisfies PolarisToolPortalCatalogRow;
    })
  );
}

export function polarisToolPortalPath(
  pathname: string,
  basePath = POLARIS_TOOL_PORTAL_BASE_PATH,
): string {
  const normalizedBase = normalizePortalBasePath(basePath);
  const normalizedPath = normalizePortalRelativePath(pathname);
  if (normalizedPath === "/") return normalizedBase;
  return `${normalizedBase}${normalizedPath}`;
}

export function listPolarisToolPortalCatalogRows(
  basePath = POLARIS_TOOL_PORTAL_BASE_PATH,
): readonly PolarisToolPortalCatalogRow[] {
  return TOOL_MANIFESTS.map((tool) => toToolPortalCatalogRow(tool, basePath));
}

export function getPolarisToolPortalDetail(
  idOrSlug: string,
  basePath = POLARIS_TOOL_PORTAL_BASE_PATH,
): PolarisToolPortalDetail | undefined {
  const tool = findPolarisToolManifest(idOrSlug);
  if (!tool) return undefined;
  return {
    ...toToolPortalCatalogRow(tool, basePath),
    description: tool.description,
    version: tool.version,
    actionId: tool.workflow.actionId,
    port: tool.workflow.port,
    portVersion: tool.workflow.portVersion,
    adapter: tool.workflow.adapter,
    approvalRequired: tool.approval.required,
    approvalPolicy: tool.approval.policy,
    credentialPolicy: tool.credentials.policy,
    credentialNotes: tool.credentials.notes,
    receipts: tool.receipts,
    requiredGates: tool.workflow.requiredGates,
    inputSchema: tool.schema.input,
    outputSchema: tool.schema.output,
    examples: tool.examples,
  };
}

export function invokeMockPolarisTool(
  input: PolarisToolMockInvocation,
): PolarisToolMockResult {
  const tool = findPolarisToolManifest(input.toolId);
  if (!tool) {
    throw new Error(`Unknown Polaris tool: ${input.toolId}`);
  }
  const receipt = {
    id: `mock-receipt-${input.requestId}`,
    owner: "polaris",
    evidence: tool.receipts.evidence,
  } as const;
  if (tool.id === POLARIS_MANUAL_REVIEW_TOOL_ID) {
    return {
      toolId: tool.id,
      requestId: input.requestId,
      status: "waiting",
      output: {
        approved: false,
        reviewId: `mock-review-${input.requestId}`,
        notes: "mock-only",
      },
      receipt,
    };
  }
  return {
    toolId: tool.id,
    requestId: input.requestId,
    status: "mocked",
    output: {
      artifactCount: 2,
      latestTitles: ["Synthetic artifact", "Synthetic receipt"],
      pendingMemoryChanges: 0,
    },
    receipt,
  };
}

export function assertFirstPartyPolarisTools(
  manifests: readonly PolarisToolManifest[] = TOOL_MANIFESTS,
): void {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const tool of manifests) {
    if (tool.publisher.id !== POLARIS_TOOL_PUBLISHER_ID || !tool.publisher.firstParty) {
      throw new Error(`Tool ${tool.id} is not first-party`);
    }
    if (ids.has(tool.id)) {
      throw new Error(`Duplicate tool id: ${tool.id}`);
    }
    if (slugs.has(tool.slug)) {
      throw new Error(`Duplicate tool slug: ${tool.slug}`);
    }
    ids.add(tool.id);
    slugs.add(tool.slug);
    if (tool.workflow.liveEnabled !== false) {
      throw new Error(`Tool ${tool.id} must fail closed by default`);
    }
  }
}

function toToolPortalCatalogRow(
  tool: PolarisToolManifest,
  basePath: string,
): PolarisToolPortalCatalogRow {
  return {
    id: tool.id,
    slug: tool.slug,
    name: tool.name,
    summary: tool.summary,
    scope: "common",
    scopeLabel: "Common",
    toolCalls: [commonToolCall(tool)],
    category: tool.category,
    tags: tool.tags,
    publisherName: tool.publisher.name,
    firstParty: tool.publisher.firstParty,
    effect: tool.workflow.effect,
    risk: tool.workflow.risk,
    liveState: tool.workflow.executionMode,
    href: polarisToolPortalPath(`/${tool.slug}`, basePath),
  };
}

function commonToolCall(tool: PolarisToolManifest): PolarisToolPortalCallRef {
  return {
    id: tool.workflow.actionId,
    port: tool.workflow.port,
    version: tool.workflow.portVersion,
    effect: tool.workflow.effect,
    ...(tool.workflow.builtin ? { builtin: tool.workflow.builtin } : {}),
    mappedToolId: tool.id,
    unresolved: false,
  };
}

function domainPackFlowToolCalls(
  flow: PolarisDomainPackToolFlowProjection,
): readonly PolarisToolPortalCallRef[] {
  return (flow.toolCalls ?? []).map((call) => ({
    id: call.id,
    port: call.port,
    version: call.version,
    effect: call.effect,
    ...(call.builtin ? { builtin: call.builtin } : {}),
    ...(commonToolIdForCall(call) ? { mappedToolId: commonToolIdForCall(call) } : {}),
    unresolved: call.unresolved,
  }));
}

function commonToolIdForCall(
  call: Pick<PolarisToolPortalCallRef, "port" | "builtin">,
): string | undefined {
  const byBuiltin = call.builtin
    ? listPolarisToolManifests().find((tool) => tool.workflow.builtin === call.builtin)
    : undefined;
  if (byBuiltin) return byBuiltin.id;
  return listPolarisToolManifests().find((tool) => tool.workflow.port === call.port)?.id;
}

function domainPackRef(pack: PolarisDomainPackToolProjection): PolarisToolPortalDomainPackRef {
  return {
    id: pack.id,
    name: pack.title,
    version: pack.version,
    digest: pack.digest,
  };
}

function domainPackToolId(packId: string, flowId: string): string {
  return `domain-pack:${packId}:${flowId}`;
}

function domainPackToolSlug(packId: string, flowId: string): string {
  return `${slugPart(packId)}-${slugPart(flowId)}`;
}

function slugPart(value: string): string {
  const slug = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return slug || "tool";
}

function normalizePortalBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/gu, "")}`;
}

function normalizePortalRelativePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  if (/^https?:\/\//iu.test(trimmed) || trimmed.startsWith("//")) {
    throw new Error("Tool portal paths must be relative");
  }
  return `/${trimmed.replace(/^\/+/u, "")}`;
}
