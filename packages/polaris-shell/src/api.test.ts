import assert from "node:assert/strict";
import test from "node:test";
import { resolveShellHostActions, type ShellHostSummary, type ShellSession } from "./api.js";

const verticalSession: ShellSession = {
  authMode: "disabled",
  authenticated: true,
  authingUserId: "synthetic-user",
  authingUsername: "synthetic-user",
  polarisUserId: "synthetic-user",
  role: "user",
  plan: "pro",
  line: "vertical",
};

const verticalHost: ShellHostSummary = {
  name: "sample-host",
  serverId: "srv_sample",
  surfaces: ["paseo", "wanghai"],
  ports: [
    { name: "paseo", containerPort: 6767, nodePort: 32101 },
    { name: "wanghai", containerPort: 9090, nodePort: 32102 },
  ],
  status: {
    driver: {
      status: "running",
    },
  },
};

const codingHost: ShellHostSummary = {
  ...verticalHost,
  surfaces: ["paseo"],
  ports: [
    { name: "paseo", containerPort: 6767, nodePort: 32101 },
  ],
};

test("vertical subscribers receive coding and embedded Wanghai actions", () => {
  assert.deepEqual(
    resolveShellHostActions({
      session: verticalSession,
      host: verticalHost,
      publicHost: "127.0.0.1",
    }),
    [
      { kind: "open-coding", href: "/h/srv_sample" },
      {
        kind: "open-wanghai",
        href: "/v/srv_sample/wanghai",
        portalUrl: "http://127.0.0.1:32102",
      },
    ],
  );
});

test("coding subscribers never receive a Wanghai action", () => {
  const actions = resolveShellHostActions({
    session: { ...verticalSession, line: "coding" },
    host: verticalHost,
    publicHost: "127.0.0.1",
  });
  assert.deepEqual(actions, [{ kind: "open-coding", href: "/h/srv_sample" }]);
});

test("a host without a paired server cannot expose surface links", () => {
  const actions = resolveShellHostActions({
    session: verticalSession,
    host: { ...verticalHost, serverId: null },
    publicHost: "127.0.0.1",
  });
  assert.deepEqual(actions, []);
});

test("a stopped host cannot expose surface links even if a serverId is cached", () => {
  const actions = resolveShellHostActions({
    session: verticalSession,
    host: {
      ...verticalHost,
      status: {
        driver: {
          status: "stopped",
        },
      },
    },
    publicHost: "127.0.0.1",
  });
  assert.deepEqual(actions, [
    {
      kind: "open-wanghai",
      href: "/v/srv_sample/wanghai",
      portalUrl: "http://127.0.0.1:32102",
    },
  ]);
});

test("both-line subscribers only receive Wanghai for vertical hosts", () => {
  assert.deepEqual(
    resolveShellHostActions({
      session: { ...verticalSession, line: "both" },
      host: codingHost,
      publicHost: "127.0.0.1",
    }),
    [{ kind: "open-coding", href: "/h/srv_sample" }],
  );
});
