import assert from "node:assert/strict";
import test from "node:test";
import { createPkceChallenge } from "./pkce.js";

test("pkce challenge falls back to plain when subtle crypto is missing", async () => {
  await assert.doesNotReject(async () => {
    await createPkceChallenge("verifier", { digest: undefined });
  });
  assert.deepEqual(await createPkceChallenge("verifier", { digest: undefined }), {
    method: "plain",
    value: "verifier",
  });
});

test("pkce challenge uses S256 when subtle crypto is available", async () => {
  const result = await createPkceChallenge("verifier", {
    async digest(_algorithm, _data) {
      return new Uint8Array([0, 1, 2]).buffer;
    },
  });
  assert.deepEqual(result, {
    method: "S256",
    value: "AAEC",
  });
});
