import assert from "node:assert/strict";
import test from "node:test";
import {
  PASEO_EMBED_READY,
  PASEO_EMBED_WORKSPACE_CREATED,
  parsePaseoEmbedMessage,
} from "../lib/paseo-embed.js";

test("accepts a well-formed Paseo workspace-created message", () => {
  assert.deepEqual(
    parsePaseoEmbedMessage({
      type: PASEO_EMBED_WORKSPACE_CREATED,
      version: 1,
      nonce: "nonce-example",
      requestId: "request-example",
      workspaceId: "workspace-example",
      agentId: "agent-example",
    }),
    {
      type: PASEO_EMBED_WORKSPACE_CREATED,
      version: 1,
      nonce: "nonce-example",
      requestId: "request-example",
      workspaceId: "workspace-example",
      agentId: "agent-example",
    },
  );
});

test("rejects malformed or unsupported Paseo messages", () => {
  assert.equal(parsePaseoEmbedMessage({ type: PASEO_EMBED_READY }), null);
  assert.equal(
    parsePaseoEmbedMessage({
      type: PASEO_EMBED_WORKSPACE_CREATED,
      version: 1,
      nonce: "nonce-example",
      requestId: "request-example",
      workspaceId: "workspace-example",
    }),
    null,
  );
  assert.equal(
    parsePaseoEmbedMessage({
      type: PASEO_EMBED_READY,
      version: 2,
      nonce: "nonce-example",
    }),
    null,
  );
});
