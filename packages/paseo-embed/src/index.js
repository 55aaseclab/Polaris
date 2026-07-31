export const PASEO_EMBED_PROTOCOL_VERSION = 1;
export const PASEO_EMBED_READY = "paseo.embed.ready";
export const PASEO_EMBED_SET_CONTEXT = "paseo.embed.context.set";
export const PASEO_EMBED_CREATE_WORKSPACE = "paseo.embed.workspace.create";
export const PASEO_EMBED_WORKSPACE_CREATED = "paseo.embed.workspace.created";
export const PASEO_EMBED_WORKSPACE_FAILED = "paseo.embed.workspace.failed";

const MAX_FIELD_LENGTH = 240;
const MAX_CONTEXT_LENGTH = 32_000;
const MAX_PATH_LENGTH = 4_096;
const DEFAULT_WORKSPACE_TIMEOUT_MS = 60_000;

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readString(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function readOptionalString(value, maxLength) {
  if (value === undefined || value === null) return undefined;
  return readString(value, maxLength);
}

function createRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function normalizeContext(value) {
  const context = asRecord(value);
  if (!context) throw new TypeError("Paseo embed context must be an object.");

  const source = readString(context.source, MAX_FIELD_LENGTH);
  const kind = readString(context.kind, MAX_FIELD_LENGTH);
  const id = readString(context.id, MAX_FIELD_LENGTH);
  const title = readString(context.title, MAX_FIELD_LENGTH);
  const text = readString(context.text, MAX_CONTEXT_LENGTH);
  const subtitle = readOptionalString(context.subtitle, MAX_FIELD_LENGTH);
  const url = readOptionalString(context.url, 2_000);
  if (!source || !kind || !id || !title || !text || subtitle === null || url === null) {
    throw new TypeError("Paseo embed context is invalid.");
  }

  return {
    source,
    kind,
    id,
    title,
    ...(subtitle ? { subtitle } : {}),
    text,
    ...(url ? { url } : {}),
  };
}

function normalizeWorkspaceRequest(value) {
  const workspace = asRecord(value);
  if (!workspace) throw new TypeError("Paseo workspace request must be an object.");

  const path = readString(workspace.path, MAX_PATH_LENGTH);
  const title = readOptionalString(workspace.title, MAX_FIELD_LENGTH);
  const requestId = readOptionalString(workspace.requestId, MAX_FIELD_LENGTH) ?? createRequestId();
  const defaultModelValue = workspace.defaultModel;
  const defaultModel = defaultModelValue === undefined ? undefined : asRecord(defaultModelValue);
  if (!path || title === null || (defaultModelValue !== undefined && !defaultModel)) {
    throw new TypeError("Paseo workspace request is invalid.");
  }

  let normalizedDefaultModel;
  if (defaultModel) {
    const provider = readString(defaultModel.provider, MAX_FIELD_LENGTH);
    const model = readOptionalString(defaultModel.model, MAX_FIELD_LENGTH);
    const thinkingOptionId = readOptionalString(defaultModel.thinkingOptionId, MAX_FIELD_LENGTH);
    if (!provider || model === null || thinkingOptionId === null) {
      throw new TypeError("Paseo default model is invalid.");
    }
    normalizedDefaultModel = {
      provider,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    };
  }

  return {
    requestId,
    path,
    ...(title ? { title } : {}),
    ...(normalizedDefaultModel ? { defaultModel: normalizedDefaultModel } : {}),
  };
}

function buildEmbedUrl(input) {
  const url = new URL(input.paseoUrl);
  const routePath = url.pathname.replace(/\/+$/, "");
  url.pathname = routePath.endsWith("/embed") ? routePath : `${routePath}/embed`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("endpoint", input.endpoint);
  url.searchParams.set("parentOrigin", input.parentOrigin);
  url.searchParams.set("nonce", input.nonce);
  if (input.agentId) url.searchParams.set("agentId", input.agentId);
  return url;
}

/**
 * Parses only messages that may originate from the embedded Paseo frame.
 * The caller must still verify message origin and frame source.
 */
export function parsePaseoEmbedMessage(value) {
  const message = asRecord(value);
  if (!message || message.version !== PASEO_EMBED_PROTOCOL_VERSION) return null;

  const nonce = readString(message.nonce, MAX_FIELD_LENGTH);
  if (!nonce) return null;

  if (message.type === PASEO_EMBED_READY) {
    return { type: PASEO_EMBED_READY, version: PASEO_EMBED_PROTOCOL_VERSION, nonce };
  }

  if (message.type === PASEO_EMBED_WORKSPACE_CREATED) {
    const requestId = readString(message.requestId, MAX_FIELD_LENGTH);
    const workspaceId = readString(message.workspaceId, MAX_FIELD_LENGTH);
    const agentId = readString(message.agentId, MAX_FIELD_LENGTH);
    if (!requestId || !workspaceId || !agentId) return null;
    return {
      type: PASEO_EMBED_WORKSPACE_CREATED,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce,
      requestId,
      workspaceId,
      agentId,
    };
  }

  if (message.type === PASEO_EMBED_WORKSPACE_FAILED) {
    const requestId = readString(message.requestId, MAX_FIELD_LENGTH);
    const error = readString(message.error, 1_000);
    if (!requestId || !error) return null;
    return {
      type: PASEO_EMBED_WORKSPACE_FAILED,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce,
      requestId,
      error,
    };
  }

  return null;
}

export function createPaseoEmbed(options) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Paseo embed requires a browser environment.");
  }
  if (!options?.container || typeof options.container.append !== "function") {
    throw new TypeError("Paseo embed requires a container element.");
  }

  const endpoint = readString(options.endpoint, MAX_FIELD_LENGTH);
  const parentOrigin = window.location.origin;
  if (!endpoint || !parentOrigin || parentOrigin === "null") {
    throw new TypeError("Paseo embed requires a valid endpoint and browser origin.");
  }

  const agentId = readOptionalString(options.agentId, MAX_FIELD_LENGTH);
  if (agentId === null) throw new TypeError("Paseo agent ID is invalid.");

  const nonce = createRequestId();
  const embedUrl = buildEmbedUrl({
    paseoUrl: options.paseoUrl,
    endpoint,
    parentOrigin,
    nonce,
    ...(agentId ? { agentId } : {}),
  });
  const paseoOrigin = embedUrl.origin;
  const iframe = document.createElement("iframe");
  iframe.className = options.className ?? "paseo-embed-frame";
  iframe.title = options.title ?? "Paseo companion";
  iframe.src = embedUrl.toString();
  iframe.setAttribute("allow", "clipboard-read; clipboard-write");

  let destroyed = false;
  let ready = false;
  let latestContext = null;
  const pendingWorkspaces = new Map();

  const reportError = (error) => options.onError?.(error);
  const postMessage = (message) => {
    if (!ready || destroyed || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(message, paseoOrigin);
  };
  const sendContext = () => {
    if (!latestContext) return;
    postMessage({
      type: PASEO_EMBED_SET_CONTEXT,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce,
      context: latestContext,
    });
  };
  const sendWorkspaceRequest = (workspace) => {
    postMessage({
      type: PASEO_EMBED_CREATE_WORKSPACE,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce,
      workspace,
    });
  };
  const flushPendingMessages = () => {
    sendContext();
    for (const { workspace } of pendingWorkspaces.values()) {
      sendWorkspaceRequest(workspace);
    }
  };

  const handleMessage = (event) => {
    if (event.origin !== paseoOrigin || event.source !== iframe.contentWindow) return;
    const message = parsePaseoEmbedMessage(event.data);
    if (!message || message.nonce !== nonce || destroyed) return;

    if (message.type === PASEO_EMBED_READY) {
      ready = true;
      flushPendingMessages();
      options.onReady?.();
      return;
    }

    if (message.type === PASEO_EMBED_WORKSPACE_CREATED) {
      const pending = pendingWorkspaces.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      pendingWorkspaces.delete(message.requestId);
      const result = {
        requestId: message.requestId,
        workspaceId: message.workspaceId,
        agentId: message.agentId,
      };
      pending.resolve(result);
      options.onWorkspaceCreated?.(result);
      return;
    }

    if (message.type === PASEO_EMBED_WORKSPACE_FAILED) {
      const pending = pendingWorkspaces.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      pendingWorkspaces.delete(message.requestId);
      const error = new Error(message.error);
      pending.reject(error);
      options.onWorkspaceFailed?.({ requestId: message.requestId, error });
      reportError(error);
    }
  };

  window.addEventListener("message", handleMessage);
  options.container.append(iframe);

  return {
    iframe,
    get ready() {
      return ready;
    },
    setContext(context) {
      if (destroyed) throw new Error("Paseo embed has been destroyed.");
      latestContext = normalizeContext(context);
      sendContext();
    },
    createWorkspace(request, requestOptions = {}) {
      if (destroyed) return Promise.reject(new Error("Paseo embed has been destroyed."));
      const workspace = normalizeWorkspaceRequest(request);
      if (pendingWorkspaces.has(workspace.requestId)) {
        return Promise.reject(new Error(`Duplicate Paseo workspace request: ${workspace.requestId}`));
      }
      const timeoutMs = requestOptions.timeoutMs ?? DEFAULT_WORKSPACE_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(new TypeError("Paseo workspace timeout must be a positive number."));
      }

      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingWorkspaces.delete(workspace.requestId);
          reject(new Error(`Paseo workspace request timed out: ${workspace.requestId}`));
        }, timeoutMs);
        pendingWorkspaces.set(workspace.requestId, { workspace, resolve, reject, timeout });
        sendWorkspaceRequest(workspace);
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener("message", handleMessage);
      for (const [requestId, pending] of pendingWorkspaces) {
        window.clearTimeout(pending.timeout);
        pending.reject(new Error(`Paseo embed was destroyed: ${requestId}`));
      }
      pendingWorkspaces.clear();
      iframe.remove();
    },
  };
}
