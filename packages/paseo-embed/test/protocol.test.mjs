import assert from "node:assert/strict";
import test from "node:test";
import {
  PASEO_EMBED_PROTOCOL_VERSION,
  PASEO_EMBED_CREATE_WORKSPACE,
  PASEO_EMBED_READY,
  PASEO_EMBED_SET_CONTEXT,
  PASEO_EMBED_WORKSPACE_CREATED,
  PASEO_EMBED_WORKSPACE_FAILED,
  createPaseoEmbed,
  parsePaseoEmbedMessage,
} from "../src/index.js";

function installFakeBrowser() {
  const listeners = new Map();
  const messages = [];
  const frame = {
    className: "",
    contentWindow: {
      postMessage: (message, targetOrigin) => messages.push({ message, targetOrigin }),
    },
    remove: () => {},
    setAttribute: () => {},
    src: "",
    title: "",
  };
  const window = {
    addEventListener: (type, callback) => {
      const callbacks = listeners.get(type) ?? new Set();
      callbacks.add(callback);
      listeners.set(type, callbacks);
    },
    clearTimeout,
    location: { origin: "http://host.test" },
    removeEventListener: (type, callback) => listeners.get(type)?.delete(callback),
    setTimeout,
  };
  const document = {
    createElement: () => frame,
  };
  const container = {
    append: (element) => assert.equal(element, frame),
  };

  return {
    container,
    document,
    frame,
    messages,
    window,
    sendMessage: (event) => {
      for (const callback of listeners.get("message") ?? []) callback(event);
    },
  };
}

test("parses a trusted-ready payload shape", () => {
  assert.deepEqual(
    parsePaseoEmbedMessage({
      type: PASEO_EMBED_READY,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce: "nonce-1",
    }),
    {
      type: PASEO_EMBED_READY,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce: "nonce-1",
    },
  );
});

test("parses workspace completion and failure payloads", () => {
  assert.deepEqual(
    parsePaseoEmbedMessage({
      type: PASEO_EMBED_WORKSPACE_CREATED,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce: "nonce-1",
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
    }),
    {
      type: PASEO_EMBED_WORKSPACE_CREATED,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce: "nonce-1",
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
    },
  );
  assert.deepEqual(
    parsePaseoEmbedMessage({
      type: PASEO_EMBED_WORKSPACE_FAILED,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce: "nonce-1",
      requestId: "request-1",
      error: "Provider is unavailable",
    }),
    {
      type: PASEO_EMBED_WORKSPACE_FAILED,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce: "nonce-1",
      requestId: "request-1",
      error: "Provider is unavailable",
    },
  );
});

test("rejects malformed or unversioned messages", () => {
  assert.equal(parsePaseoEmbedMessage({ type: PASEO_EMBED_READY }), null);
  assert.equal(
    parsePaseoEmbedMessage({
      type: PASEO_EMBED_WORKSPACE_CREATED,
      version: PASEO_EMBED_PROTOCOL_VERSION,
      nonce: "nonce-1",
      requestId: "request-1",
      workspaceId: "workspace-1",
    }),
    null,
  );
});

test("queues workspace creation until the trusted frame is ready", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const browser = installFakeBrowser();
  globalThis.window = browser.window;
  globalThis.document = browser.document;
  let embed;
  let creation;

  try {
    embed = createPaseoEmbed({
      container: browser.container,
      paseoUrl: "http://paseo.test/paseo",
      endpoint: "daemon.test:6768",
    });
    embed.setContext({
      source: "host",
      kind: "record",
      id: "record-1",
      title: "Record 1",
      text: "Host context",
    });
    creation = embed.createWorkspace({ path: "/workspace/project" });

    assert.equal(browser.messages.length, 0);
    const nonce = new URL(browser.frame.src).searchParams.get("nonce");
    browser.sendMessage({
      origin: "http://untrusted.test",
      source: browser.frame.contentWindow,
      data: { type: PASEO_EMBED_READY, version: PASEO_EMBED_PROTOCOL_VERSION, nonce },
    });
    assert.equal(browser.messages.length, 0);

    browser.sendMessage({
      origin: "http://paseo.test",
      source: browser.frame.contentWindow,
      data: { type: PASEO_EMBED_READY, version: PASEO_EMBED_PROTOCOL_VERSION, nonce },
    });
    assert.deepEqual(
      browser.messages.map(({ message }) => message.type),
      [PASEO_EMBED_SET_CONTEXT, PASEO_EMBED_CREATE_WORKSPACE],
    );

    const requestId = browser.messages[1].message.workspace.requestId;
    browser.sendMessage({
      origin: "http://paseo.test",
      source: browser.frame.contentWindow,
      data: {
        type: PASEO_EMBED_WORKSPACE_CREATED,
        version: PASEO_EMBED_PROTOCOL_VERSION,
        nonce,
        requestId,
        workspaceId: "workspace-1",
        agentId: "agent-1",
      },
    });

    assert.deepEqual(await creation, {
      requestId,
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });
  } finally {
    embed?.destroy();
    await creation?.catch(() => {});
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
