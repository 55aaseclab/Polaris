export const PASEO_EMBED_PROTOCOL_VERSION: 1;
export const PASEO_EMBED_READY: "paseo.embed.ready";
export const PASEO_EMBED_SET_CONTEXT: "paseo.embed.context.set";
export const PASEO_EMBED_CREATE_WORKSPACE: "paseo.embed.workspace.create";
export const PASEO_EMBED_WORKSPACE_CREATED: "paseo.embed.workspace.created";
export const PASEO_EMBED_WORKSPACE_FAILED: "paseo.embed.workspace.failed";

export interface PaseoEmbedContext {
  source: string;
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  text: string;
  url?: string;
}

export interface PaseoEmbedDefaultModel {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
}

export interface PaseoEmbedWorkspaceRequest {
  path: string;
  requestId?: string;
  title?: string;
  defaultModel?: PaseoEmbedDefaultModel;
}

export interface PaseoEmbedWorkspaceResult {
  requestId: string;
  workspaceId: string;
  agentId: string;
}

export interface PaseoEmbedOptions {
  container: HTMLElement;
  paseoUrl: string;
  endpoint: string;
  agentId?: string;
  className?: string;
  title?: string;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onWorkspaceCreated?: (result: PaseoEmbedWorkspaceResult) => void;
  onWorkspaceFailed?: (input: { requestId: string; error: Error }) => void;
}

export interface PaseoEmbedHandle {
  readonly iframe: HTMLIFrameElement;
  readonly ready: boolean;
  setContext(context: PaseoEmbedContext): void;
  createWorkspace(
    request: PaseoEmbedWorkspaceRequest,
    options?: { timeoutMs?: number },
  ): Promise<PaseoEmbedWorkspaceResult>;
  destroy(): void;
}

export type PaseoEmbedInboundMessage =
  | { type: typeof PASEO_EMBED_READY; version: 1; nonce: string }
  | {
      type: typeof PASEO_EMBED_WORKSPACE_CREATED;
      version: 1;
      nonce: string;
      requestId: string;
      workspaceId: string;
      agentId: string;
    }
  | {
      type: typeof PASEO_EMBED_WORKSPACE_FAILED;
      version: 1;
      nonce: string;
      requestId: string;
      error: string;
    };

export function parsePaseoEmbedMessage(value: unknown): PaseoEmbedInboundMessage | null;
export function createPaseoEmbed(options: PaseoEmbedOptions): PaseoEmbedHandle;
