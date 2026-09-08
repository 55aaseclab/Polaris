import assert from "node:assert/strict";
import test from "node:test";
import {
  wanghaiMutationFetch,
  withWanghaiMutationIdempotency,
} from "../lib/mutation-request.js";

test("mutation requests receive one bounded idempotency key", () => {
  const request = withWanghaiMutationIdempotency({ method: "POST" }, "mutation-001");
  assert.equal(new Headers(request.headers).get("idempotency-key"), "mutation-001");

  const preserved = withWanghaiMutationIdempotency({
    method: "PATCH",
    headers: { "idempotency-key": "existing-key" },
  }, "replacement-key");
  assert.equal(new Headers(preserved.headers).get("idempotency-key"), "existing-key");

  const read = withWanghaiMutationIdempotency({ method: "GET" }, "read-key");
  assert.equal(new Headers(read.headers).get("idempotency-key"), null);
});

test("mutation requests use getRandomValues when randomUUID is unavailable", () => {
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const bytes = new Uint8Array(16).fill(0xab);
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues<T extends ArrayBufferView>(array: T): T {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
        return array;
      },
    },
  });
  try {
    const request = withWanghaiMutationIdempotency({ method: "POST" });
    assert.equal(
      new Headers(request.headers).get("idempotency-key"),
      "abababab-abab-4bab-abab-abababababab",
    );
  } finally {
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "crypto");
    }
  }
});

test("safe requests do not require a crypto API", () => {
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: undefined,
  });
  try {
    const request = withWanghaiMutationIdempotency({ method: "GET" });
    assert.equal(new Headers(request.headers).get("idempotency-key"), null);
  } finally {
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "crypto");
    }
  }
});

test("local development can defer idempotency generation to its signed adapter", () => {
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const previousLocalMode = process.env.NEXT_PUBLIC_POLARIS_BUSINESS_LOCAL_DEVELOPMENT;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: undefined,
  });
  process.env.NEXT_PUBLIC_POLARIS_BUSINESS_LOCAL_DEVELOPMENT = "1";
  try {
    const request = withWanghaiMutationIdempotency({ method: "POST" });
    assert.match(new Headers(request.headers).get("idempotency-key") ?? "", /^[a-z0-9-]+$/u);
  } finally {
    if (previousLocalMode === undefined) delete process.env.NEXT_PUBLIC_POLARIS_BUSINESS_LOCAL_DEVELOPMENT;
    else process.env.NEXT_PUBLIC_POLARIS_BUSINESS_LOCAL_DEVELOPMENT = previousLocalMode;
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "crypto");
    }
  }
});

test("versioned mutation requests fetch and attach the current workspace version", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    if (input === "/wanghai/api/workspaces/acme/version") {
      return new Response(JSON.stringify({ workspace_version: 4 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  try {
    const response = await wanghaiMutationFetch(
      "/api/workspaces/acme/products/SKU-001",
      {
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    assert.equal(response.status, 201);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].input, "/wanghai/api/workspaces/acme/version");
    const headers = new Headers(requests[1].init?.headers);
    assert.equal(headers.get("x-polaris-expected-version"), "4");
    assert.match(headers.get("idempotency-key") ?? "", /^[0-9a-f-]{36}$/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mutation requests preserve a caller-provided workspace version", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await wanghaiMutationFetch("/api/workspaces/acme/workflows", {
      headers: { "x-polaris-expected-version": "7" },
      method: "POST",
    });
    assert.equal(requests.length, 1);
    assert.equal(
      new Headers(requests[0].init?.headers).get("x-polaris-expected-version"),
      "7",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mutation requests mount URL and Request inputs below the Wanghai path", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return new Response(JSON.stringify({ ok: true, workspace_version: 1 }), { status: 200 });
  };
  try {
    await wanghaiMutationFetch(
      new URL("https://wanghai.test/api/workspaces/acme/workflows"),
      { method: "POST", headers: { "x-polaris-expected-version": "1" } },
    );
    await wanghaiMutationFetch(
      new Request("https://wanghai.test/api/workspaces/acme/workflows", {
        method: "POST",
        body: "{}",
      }),
      { headers: { "x-polaris-expected-version": "1" } },
    );
    assert.equal(String(requests[0].input), "https://wanghai.test/wanghai/api/workspaces/acme/workflows");
    assert.equal((requests[1].input as Request).url, "https://wanghai.test/wanghai/api/workspaces/acme/workflows");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
