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
  wanghaiId: "wg_sample",
  surfaces: ["paseo", "wanghai"],
  status: {
    driver: {
      status: "running",
    },
  },
};

const codingHost: ShellHostSummary = {
  ...verticalHost,
  surfaces: ["paseo"],
};

test("vertical subscribers receive only the vertical action for vertical hosts", () => {
  assert.deepEqual(
    resolveShellHostActions({
      session: verticalSession,
      host: verticalHost,
    }),
    [{
      kind: "open-wanghai",
      href: "/v/wg_sample/wanghai",
    }],
  );
});

test("coding subscribers cannot open vertical hosts", () => {
  const actions = resolveShellHostActions({
    session: { ...verticalSession, line: "coding" },
    host: verticalHost,
  });
  assert.deepEqual(actions, []);
});

test("a host without a Wanghai gateway identity cannot expose the Wanghai link", () => {
  const actions = resolveShellHostActions({
    session: verticalSession,
    host: { ...verticalHost, wanghaiId: null },
  });
  assert.deepEqual(actions, []);
});

test("a stopped vertical host keeps only the vertical action when a Wanghai identity is cached", () => {
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
  });
  assert.deepEqual(actions, [
    {
      kind: "open-wanghai",
      href: "/v/wg_sample/wanghai",
    },
  ]);
});

test("both-line subscribers get exactly one surface action per host", () => {
  assert.deepEqual(
    resolveShellHostActions({
      session: { ...verticalSession, line: "both" },
      host: verticalHost,
    }),
    [{
      kind: "open-wanghai",
      href: "/v/wg_sample/wanghai",
    }],
  );

  assert.deepEqual(
    resolveShellHostActions({
      session: { ...verticalSession, line: "both" },
      host: codingHost,
    }),
    [{ kind: "open-coding", href: "/v/srv_sample/coding" }],
  );
});
