import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import yaml from "js-yaml";
import { createPortalServer } from "../scripts/portal/server.js";
import {
  getPortalWorkspaceDetail,
  reportPortalWorkspaceStatus,
  stopPortalWorkspace,
} from "../scripts/portal/service.js";
import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import {
  listOwnedWorkspaces,
  readWorkspaceProvisionProgress,
  readWorkspaceStatus,
  writeWorkspaceProvisionProgress,
  clearWorkspaceProvisionProgress,
} from "../scripts/core/portal.js";
import { writeWorkspaceDriverSelection, writeWorkspaceStatus } from "../scripts/output/state-store.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const USER_MAP_PATH = path.join(REPO_ROOT, "config", "users", "user-map.json");
const DEMO_USER_ID = "100000000000000001";

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function waitFor<T>(
  read: () => T | null,
  options?: {
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 15000;
  const intervalMs = options?.intervalMs ?? 100;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function waitForProvisionDone(userId: string, workspace: string) {
  return waitFor(() => {
    const progress = readWorkspaceProvisionProgress(userId, workspace);
    return progress?.done ? progress : null;
  });
}

async function withFakePath(
  commands: Record<string, string>,
  fn: (ctx: { readCommandLog: () => string[] }) => Promise<void> | void,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-portal-"));
  const commandLogPath = path.join(tempDir, "commands.log");
  const originalPath = process.env.PATH || "";
  for (const [name, body] of Object.entries(commands)) {
    fs.writeFileSync(
      path.join(tempDir, name),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(commandLogPath)}
${body}
`,
      { mode: 0o755 },
    );
  }
  process.env.PATH = `${tempDir}:${originalPath}`;
  try {
    await fn({
      readCommandLog: () =>
        fs.existsSync(commandLogPath)
          ? fs.readFileSync(commandLogPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
          : [],
    });
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function withPortalServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createPortalServer(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Portal server did not expose a TCP address");
  }
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function withPortalAuthEnv(
  secret: string,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env.POLARIS_AUTH_SHARED_SECRET;
  process.env.POLARIS_AUTH_SHARED_SECRET = secret;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.POLARIS_AUTH_SHARED_SECRET;
    } else {
      process.env.POLARIS_AUTH_SHARED_SECRET = previous;
    }
  }
}

async function withEnv(
  name: string,
  value: string,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

async function withSyntheticMemberUser(
  fn: (userId: string, workspace: string) => Promise<void>,
): Promise<void> {
  const userId = uniqueName("portal-member");
  const workspace = uniqueName("portal-member-workspace");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const workspaceRoot = path.join(REPO_ROOT, "config", "users", userId, "workspaces", workspace);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(
    profilePath,
    yaml.dump({
      id: userId,
      name: "Portal Member",
      email: `${userId}@polaris.local`,
      workspaces: [workspace],
      github: {
        account: null,
      },
      ssh: {
        mode: "managed-key",
        comment: `${userId}@polaris.local`,
      },
    }, { lineWidth: 120, noRefs: true }),
    "utf8",
  );
  try {
    await fn(userId, workspace);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userId), {
      recursive: true,
      force: true,
    });
  }
}

test("workspace ownership is derived from the project directory", () => {
  const userId = "100000000000000001";
  const workspace = uniqueName("portal-owned");
  const root = path.join(REPO_ROOT, "config", "users", userId, "workspaces", workspace);
  fs.mkdirSync(root, { recursive: true });
  try {
    assert.ok(listOwnedWorkspaces(userId).includes(workspace));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("portal provisioning progress persists across reads", () => {
  const userId = DEMO_USER_ID;
  const workspace = uniqueName("portal-progress");
  const progress = {
    userId,
    workspace,
    phase: "images",
    step: 2,
    totalSteps: 6,
    percent: 33,
    message: "building images",
    updatedAt: new Date().toISOString(),
    done: false,
  };
  try {
    writeWorkspaceProvisionProgress(userId, workspace, progress);
    assert.deepEqual(readWorkspaceProvisionProgress(userId, workspace), progress);
  } finally {
    clearWorkspaceProvisionProgress(userId, workspace);
  }
});

test("portal workspace detail reads cached state without implicit refresh side effects", async () => {
  await withFakePath(
    {
      docker: "#!/bin/sh\nexit 0\n",
      kubectl: "#!/bin/sh\nexit 0\n",
    },
    async ({ readCommandLog }) => {
      const detail = getPortalWorkspaceDetail(DEMO_USER_ID, "demo");
      assert.equal(detail.name, "demo");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(readCommandLog(), []);
    },
  );
});

test("portal API accepts runtime status reports and persists cached workspace state", async () => {
  const userId = DEMO_USER_ID;
  const workspace = "demo";
  const previous = readWorkspaceStatus(userId, workspace);
  writeWorkspaceStatus({
    project: workspace,
    state: "saved",
    backend: {
      kind: "docker",
      instanceState: "stopped",
    },
    driver: {
      target: "docker",
      baseImage: "ttl.sh/example:24h",
      runtimeKind: "docker-container",
      runtimeRef: `${workspace}-docker`,
      runtimeState: "stopped",
    },
    health: {
      backendLiveness: "stopped",
      workspaceReadiness: "not-ready",
      daemonReadiness: "degraded",
      reason: "test setup",
    },
    daemon: {
      manager: {
        state: "missing",
      },
    },
    details: {},
  }, userId);
  try {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/users/${userId}/workspaces/${workspace}/refresh`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assert.equal(response.status, 200);
    });
    await withPortalServer(async (baseUrl) => {
      const detailBefore = await fetch(
        `${baseUrl}/api/users/${userId}/workspaces/${workspace}`,
      );
      assert.equal(detailBefore.status, 200);
      const parsedBefore = await detailBefore.json() as {
        status?: { state?: string; daemon?: { manager?: { state?: string } } };
      };
      assert.equal(parsedBefore.status?.state, "saved");

      await reportPortalWorkspaceStatus({
        userId,
        workspace,
        status: {
          state: "ready",
          backend: {
            instanceState: "running",
          },
          driver: {
            runtimeState: "running",
          },
          daemon: {
            manager: {
              state: "ok",
            },
          },
          details: {
            backendDetail: "reported by test",
          },
        },
      });

      const detailAfter = await fetch(
        `${baseUrl}/api/users/${userId}/workspaces/${workspace}`,
      );
      assert.equal(detailAfter.status, 200);
      const parsedAfter = await detailAfter.json() as {
        status?: {
          state?: string;
          backend?: { instanceState?: string };
          driver?: { runtimeState?: string };
          daemon?: { manager?: { state?: string } };
          details?: { backendDetail?: string };
        };
      };
      assert.equal(parsedAfter.status?.state, "ready");
      assert.equal(parsedAfter.status?.backend?.instanceState, "running");
      assert.equal(parsedAfter.status?.driver?.runtimeState, "running");
      assert.equal(parsedAfter.status?.daemon?.manager?.state, "ok");
      assert.equal(parsedAfter.status?.details?.backendDetail, "reported by test");
    });
  } finally {
    if (previous) {
      writeWorkspaceStatus(previous, userId);
    }
  }
});

test("portal workspace stop writes cached status before the async refresh completes", async () => {
  const userId = uniqueName("portal-stop-cache-user");
  const workspace = uniqueName("portal-stop-cache");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const workspaceRoot = path.join(REPO_ROOT, "config", "users", userId, "workspaces", workspace);
  try {
    await createUserCommand([userId, "--name", "Portal Stop Cache User", "--email", `${userId}@polaris.local`]);
    await createCommand([workspace, "--user", userId]);
    writeWorkspaceDriverSelection(workspace, { backend: "docker" }, userId);
    writeWorkspaceStatus({
      project: workspace,
      state: "ready",
      backend: {
        kind: "docker",
        instanceState: "running",
      },
      driver: {
        target: "docker",
        baseImage: "ttl.sh/example:24h",
        runtimeKind: "docker-container",
        runtimeRef: `${workspace}-docker`,
        runtimeState: "running",
      },
      health: {
        backendLiveness: "running",
        workspaceReadiness: "ready",
        daemonReadiness: "ready",
        reason: "test setup",
      },
      details: {},
    }, userId);

    await withFakePath(
      {
        docker: "#!/bin/sh\nif [ \"$1\" = \"compose\" ] && [ \"$4\" = \"stop\" ]; then sleep 0.05; exit 0; fi\nif [ \"$1\" = \"compose\" ] && [ \"$4\" = \"ps\" ]; then sleep 0.3; exit 0; fi\nif [ \"$1\" = \"compose\" ]; then exit 0; fi\nif [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi\nexit 0\n",
        kubectl: "#!/bin/sh\nexit 0\n",
      },
      async () => {
        const stderrChunks: string[] = [];
        const originalWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
          stderrChunks.push(
            typeof chunk === "string"
              ? chunk
              : Buffer.from(chunk).toString("utf8"),
          );
          const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
          callback?.();
          return true;
        }) as typeof process.stderr.write;
        try {
          await stopPortalWorkspace(userId, workspace);
          await new Promise((resolve) => setTimeout(resolve, 350));
        } finally {
          process.stderr.write = originalWrite;
        }
        const stderrOutput = stderrChunks.join("");
        const cachedIndex = stderrOutput.indexOf("workspace-status-cached");
        const refreshCompletedIndex = stderrOutput.indexOf("workspace-status-refresh-completed");
        assert.notEqual(cachedIndex, -1);
        assert.notEqual(refreshCompletedIndex, -1);
        assert.ok(cachedIndex < refreshCompletedIndex);
      },
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userId), {
      recursive: true,
      force: true,
    });
  }
});

test("portal API serves route-scoped workspaces and credentials without auth", async () => {
  const credentialId = uniqueName("portal-cred");
  const userId = DEMO_USER_ID;

  await withPortalServer(async (baseUrl) => {
    const selfResponse = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
    });
    assert.equal(selfResponse.status, 200);
    const selfPayload = await selfResponse.json() as { workspaces: Array<{ name: string }> };
    assert.ok(selfPayload.workspaces.some((workspace) => workspace.name === "demo"));

    const createResponse = await fetch(
      `${baseUrl}/api/users/${userId}/credentials/create`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialId,
          kind: "api-key",
          label: "Portal Test Credential",
          purposes: "agent-auth",
          content: "{\"token\":\"test\"}\n",
        }),
      },
    );
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json() as { id: string };
    assert.equal(created.id, credentialId);

    const credentialsResponse = await fetch(`${baseUrl}/api/users/${userId}/credentials`, {
    });
    assert.equal(credentialsResponse.status, 200);
    const credentialsPayload = await credentialsResponse.json() as { credentials: Array<{ id: string }> };
    assert.ok(credentialsPayload.credentials.some((credential) => credential.id === credentialId));
  });

  fs.rmSync(path.join(REPO_ROOT, "config", "users", userId, "credentials", `${credentialId}.yaml`), {
    force: true,
  });
  fs.rmSync(path.join(REPO_ROOT, "config", "users", userId, "credentials", "generated", credentialId), {
    recursive: true,
    force: true,
  });
});

test("portal API previews credential asset content", async () => {
  const credentialId = uniqueName("portal-preview");
  const userId = DEMO_USER_ID;

  try {
    await withPortalServer(async (baseUrl) => {
      const createResponse = await fetch(
        `${baseUrl}/api/users/${userId}/credentials/create`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            credentialId,
            kind: "api-key",
            label: "Portal Preview Credential",
            purposes: "agent-auth",
            content: "{\"token\":\"preview-test\"}\n",
          }),
        },
      );
      assert.equal(createResponse.status, 200);

      const previewResponse = await fetch(
        `${baseUrl}/api/users/${userId}/credentials/preview?path=${encodeURIComponent(`credentials/generated/${credentialId}/auth.json`)}`,
      );
      assert.equal(previewResponse.status, 200);
      const preview = await previewResponse.json() as { path: string; content: string; truncated: boolean };
      assert.equal(preview.path, `credentials/generated/${credentialId}/auth.json`);
      assert.match(preview.content, /preview-test/);
      assert.equal(preview.truncated, false);
    });
  } finally {
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userId, "credentials", `${credentialId}.yaml`), {
      force: true,
    });
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userId, "credentials", "generated", credentialId), {
      recursive: true,
      force: true,
    });
  }
});

test("portal API creates and deletes a codex credential for an existing user", async () => {
  const userId = uniqueName("portal-credential-user");
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);

  try {
    await createUserCommand([userId, "--name", "Portal Credential User", "--email", `${userId}@polaris.local`]);

    let createdCredentialId = "";
    await withPortalServer(async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/users/${userId}/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harness: "codex",
          label: "RightCode Codex",
          providerName: "rightcode",
          baseUrl: "https://right.codes/codex/v1",
          apiKey: "test-api-key",
        }),
      });
      const createBody = await createResponse.text();
      assert.equal(createResponse.status, 201, createBody);
      const created = JSON.parse(createBody) as {
        id: string;
        kind: string;
        paths: string[];
        active: boolean;
      };
      createdCredentialId = created.id;
      assert.equal(created.kind, "codex-auth");
      assert.equal(created.active, false);
      assert.deepEqual(created.paths, [
        `credentials/codex/${created.id}/auth.json`,
        `credentials/codex/${created.id}/config.toml`,
      ]);

      const createdRegistryPath = path.join(userRoot, "credentials", `${created.id}.yaml`);
      const createdAuthPath = path.join(userRoot, "credentials", "codex", created.id, "auth.json");
      const createdConfigPath = path.join(userRoot, "credentials", "codex", created.id, "config.toml");
      assert.equal(fs.existsSync(createdRegistryPath), true);
      assert.equal(fs.existsSync(createdAuthPath), true);
      assert.equal(fs.existsSync(createdConfigPath), true);

      const registry = (yaml.load(fs.readFileSync(createdRegistryPath, "utf8")) ?? {}) as {
        id?: string;
        kind?: string;
        label?: string;
        purposes?: string[];
        materialRef?: {
          files?: Array<{ key?: string; source_path?: string }>;
        };
      };
      assert.equal(registry.id, created.id);
      assert.equal(registry.kind, "codex-auth");
      assert.equal(registry.label, "RightCode Codex");
      assert.deepEqual(registry.purposes, ["agent-auth"]);
      assert.equal((registry as { metadata?: { active?: boolean } }).metadata?.active, false);
      assert.deepEqual(registry.materialRef?.files, [
        {
          key: "codex-auth.json",
          source_path: `credentials/codex/${created.id}/auth.json`,
        },
        {
          key: "codex-config.toml",
          source_path: `credentials/codex/${created.id}/config.toml`,
        },
      ]);

      const auth = JSON.parse(fs.readFileSync(createdAuthPath, "utf8")) as {
        OPENAI_API_KEY?: string;
      };
      assert.equal(auth.OPENAI_API_KEY, "test-api-key");

      const configToml = fs.readFileSync(createdConfigPath, "utf8");
      assert.match(configToml, /model_provider = "rightcode"/);
      assert.match(configToml, /model = "gpt-5\.5"/);
      assert.match(configToml, /\[model_providers\.rightcode\]/);
      assert.match(configToml, /base_url = "https:\/\/right\.codes\/codex\/v1"/);

      const activateResponse = await fetch(
        `${baseUrl}/api/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(createdCredentialId)}/activate`,
        { method: "POST" },
      );
      const activateBody = await activateResponse.text();
      assert.equal(activateResponse.status, 200, activateBody);
      const activated = JSON.parse(activateBody) as {
        id: string;
        active: boolean;
      };
      assert.equal(activated.id, createdCredentialId);
      assert.equal(activated.active, true);
      const activatedRegistry = (yaml.load(fs.readFileSync(createdRegistryPath, "utf8")) ?? {}) as {
        metadata?: { active?: boolean };
      };
      assert.equal(activatedRegistry.metadata?.active, true);

      const deleteResponse = await fetch(
        `${baseUrl}/api/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(createdCredentialId)}`,
        { method: "DELETE" },
      );
      const deleteBody = await deleteResponse.text();
      assert.equal(deleteResponse.status, 200, deleteBody);
      const deleted = JSON.parse(deleteBody) as {
        credential: {
          id: string;
          removed: boolean;
          removedPaths: string[];
        };
      };
      assert.equal(deleted.credential.id, createdCredentialId);
      assert.equal(deleted.credential.removed, true);
      assert.deepEqual(deleted.credential.removedPaths, [
        `credentials/codex/${createdCredentialId}/auth.json`,
        `credentials/codex/${createdCredentialId}/config.toml`,
      ]);
    });

    assert.equal(fs.existsSync(path.join(userRoot, "credentials", `${createdCredentialId}.yaml`)), false);
    assert.equal(fs.existsSync(path.join(userRoot, "credentials", "codex", createdCredentialId, "auth.json")), false);
    assert.equal(fs.existsSync(path.join(userRoot, "credentials", "codex", createdCredentialId, "config.toml")), false);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal API creates and deletes a codex credential for demo user 001", async () => {
  const userId = DEMO_USER_ID;
  const credentialId = uniqueName("demo-codex");
  const registryPath = path.join(REPO_ROOT, "config", "users", userId, "credentials", `${credentialId}.yaml`);
  const authPath = path.join(REPO_ROOT, "config", "users", userId, "credentials", "codex", credentialId, "auth.json");
  const configPath = path.join(REPO_ROOT, "config", "users", userId, "credentials", "codex", credentialId, "config.toml");

  try {
    await withPortalServer(async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/users/${userId}/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harness: "codex",
          credentialId,
          label: "rightcode",
          providerName: "rightcode",
          baseUrl: "https://right.codes/codex/v1",
          apiKey: "demo-user-test-key",
        }),
      });
      const createBody = await createResponse.text();
      assert.equal(createResponse.status, 201, createBody);
      const created = JSON.parse(createBody) as {
        id: string;
        kind: string;
        label: string;
        paths: string[];
      };
      assert.equal(created.id, credentialId);
      assert.equal(created.kind, "codex-auth");
      assert.equal(created.label, "rightcode");
      assert.deepEqual(created.paths, [
        `credentials/codex/${credentialId}/auth.json`,
        `credentials/codex/${credentialId}/config.toml`,
      ]);
      assert.equal(fs.existsSync(registryPath), true);
      assert.equal(fs.existsSync(authPath), true);
      assert.equal(fs.existsSync(configPath), true);

      const registry = (yaml.load(fs.readFileSync(registryPath, "utf8")) ?? {}) as {
        id?: string;
        kind?: string;
        label?: string;
        purposes?: string[];
      };
      assert.equal(registry.id, credentialId);
      assert.equal(registry.kind, "codex-auth");
      assert.equal(registry.label, "rightcode");
      assert.deepEqual(registry.purposes, ["agent-auth"]);

      const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
        OPENAI_API_KEY?: string;
      };
      assert.equal(auth.OPENAI_API_KEY, "demo-user-test-key");

      const configToml = fs.readFileSync(configPath, "utf8");
      assert.match(configToml, /model_provider = "rightcode"/);
      assert.match(configToml, /model = "gpt-5\.5"/);
      assert.match(configToml, /base_url = "https:\/\/right\.codes\/codex\/v1"/);

      const deleteResponse = await fetch(
        `${baseUrl}/api/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`,
        { method: "DELETE" },
      );
      const deleteBody = await deleteResponse.text();
      assert.equal(deleteResponse.status, 200, deleteBody);
      const deleted = JSON.parse(deleteBody) as {
        credential: {
          id: string;
          removed: boolean;
          removedPaths: string[];
        };
      };
      assert.equal(deleted.credential.id, credentialId);
      assert.equal(deleted.credential.removed, true);
      assert.deepEqual(deleted.credential.removedPaths, [
        `credentials/codex/${credentialId}/auth.json`,
        `credentials/codex/${credentialId}/config.toml`,
      ]);
    });

    assert.equal(fs.existsSync(registryPath), false);
    assert.equal(fs.existsSync(authPath), false);
    assert.equal(fs.existsSync(configPath), false);
  } finally {
    fs.rmSync(registryPath, { force: true });
    fs.rmSync(authPath, { force: true });
    fs.rmSync(configPath, { force: true });
    fs.rmSync(path.dirname(authPath), { recursive: true, force: true });
  }
});

test("portal API exposes the credential catalog and creates a claude inventory credential", async () => {
  const userId = uniqueName("portal-claude-user");
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const profilePath = path.join(
    REPO_ROOT,
    "config",
    "users",
    "profiles",
    `${userId}.yaml`,
  );

  try {
    await createUserCommand([
      userId,
      "--name",
      "Portal Claude User",
      "--email",
      `${userId}@polaris.local`,
    ]);

    await withPortalServer(async (baseUrl) => {
      const catalogResponse = await fetch(
        `${baseUrl}/api/users/${userId}/credentials/catalog`,
      );
      const catalogBody = await catalogResponse.text();
      assert.equal(catalogResponse.status, 200, catalogBody);
      const catalog = JSON.parse(catalogBody) as {
        harnesses: Array<{ id: string; supportsCreate: boolean; supportsLiveSwitch: boolean }>;
        presetsByHarness: Record<string, Array<{ id: string }>>;
      };
      assert.ok(catalog.harnesses.some((item) => item.id === "claude"));
      assert.ok(catalog.harnesses.some((item) => item.id === "ssh" && item.supportsLiveSwitch === true));
      assert.ok(catalog.harnesses.some((item) => item.id === "codex" && item.supportsLiveSwitch === true));
      assert.ok(catalog.harnesses.some((item) => item.id === "claude" && item.supportsLiveSwitch === true));
      assert.ok(catalog.harnesses.some((item) => item.id === "copilot" && item.supportsLiveSwitch === true));
      assert.ok(catalog.harnesses.some((item) => item.id === "opencode" && item.supportsLiveSwitch === true));
      assert.ok(catalog.harnesses.some((item) => item.id === "pi" && item.supportsLiveSwitch === true));
      assert.ok(catalog.presetsByHarness.codex?.some((item) => item.id === "rightcode"));
      assert.ok(catalog.presetsByHarness.claude?.some((item) => item.id === "anthropic"));
      assert.ok(
        catalog.presetsByHarness.copilot?.some(
          (item) => item.id === "github-copilot",
        ),
      );
      assert.ok(
        catalog.presetsByHarness.opencode?.some(
          (item) => item.id === "openrouter",
        ),
      );
      assert.ok(
        catalog.presetsByHarness.pi?.some(
          (item) => item.id === "openai-compatible",
        ),
      );

      const createResponse = await fetch(
        `${baseUrl}/api/users/${userId}/credentials`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harness: "claude",
            credentialId: "claude-default",
            presetId: "anthropic",
            apiKey: "claude-secret",
          }),
        },
      );
      const createBody = await createResponse.text();
      assert.equal(createResponse.status, 201, createBody);
      const created = JSON.parse(createBody) as {
        id: string;
        harness: string;
        kind: string;
        paths: string[];
        liveSwitchSupported: boolean;
      };
      assert.equal(created.id, "claude-default");
      assert.equal(created.harness, "claude");
      assert.equal(created.kind, "api-key");
      assert.equal(created.liveSwitchSupported, true);
      assert.deepEqual(created.paths, [
        "credentials/claude/claude-default/credential.json",
      ]);

      const materialPath = path.join(
        userRoot,
        "credentials",
        "claude",
        "claude-default",
        "credential.json",
      );
      assert.equal(fs.existsSync(materialPath), true);
      const material = JSON.parse(fs.readFileSync(materialPath, "utf8")) as {
        harness?: string;
        providerName?: string;
        baseUrl?: string;
        presetId?: string;
        apiKey?: string;
      };
      assert.equal(material.harness, "claude");
      assert.equal(material.providerName, "anthropic");
      assert.equal(material.baseUrl, "https://api.anthropic.com");
      assert.equal(material.presetId, "anthropic");
      assert.equal(material.apiKey, "claude-secret");

      const activateResponse = await fetch(
        `${baseUrl}/api/users/${userId}/credentials/claude-default/activate`,
        { method: "POST" },
      );
      const activateBody = await activateResponse.text();
      assert.equal(activateResponse.status, 200, activateBody);
      const activated = JSON.parse(activateBody) as {
        id: string;
        harness: string;
        active: boolean;
      };
      assert.equal(activated.id, "claude-default");
      assert.equal(activated.harness, "claude");
      assert.equal(activated.active, true);
    });
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal API reads and updates user profiles", async () => {
  const userId = "100000000000000001";
  const original = fs.readFileSync(path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`), "utf8");

  await withPortalServer(async (baseUrl) => {
    const getResponse = await fetch(`${baseUrl}/api/users/${userId}/profile`);
    assert.equal(getResponse.status, 200);
    const profile = await getResponse.json() as { name: string; email: string };
    assert.equal(profile.name, "Demo User");

    const postResponse = await fetch(`${baseUrl}/api/users/${userId}/profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Demo User Updated",
        email: "demo@example.com",
        githubAccount: "demo-account",
        sshComment: "demo@example.com",
      }),
    });
    assert.equal(postResponse.status, 200);
    const updated = await postResponse.json() as { name: string; githubAccount?: string };
    assert.equal(updated.name, "Demo User Updated");
    assert.equal(updated.githubAccount, "demo-account");
  });

  fs.writeFileSync(
    path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`),
    original,
    "utf8",
  );
});

test("portal API returns workspace detail for a user-scoped workspace", async () => {
  await withPortalServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/users/${DEMO_USER_ID}/workspaces/demo`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      name: string;
      selectedDriver: { backend: string; profile?: string } | null;
      availableDrivers: Array<{ backend: string; available: boolean }>;
      credentialBindings: Array<{ purpose: string; credentialId: string }>;
    };
    assert.equal(payload.name, "demo");
    assert.ok(Array.isArray(payload.availableDrivers));
    assert.ok(payload.availableDrivers.some((driver) => driver.backend === "docker"));
    assert.ok(Array.isArray(payload.credentialBindings));
  });
});

test("portal API workspace detail does not leak bindings from another user with the same workspace name", async () => {
  const workspace = uniqueName("shared-name");
  const firstUserId = uniqueName("portal-scope-a");
  const secondUserId = uniqueName("portal-scope-b");
  const firstUserRoot = path.join(REPO_ROOT, "config", "users", firstUserId);
  const secondUserRoot = path.join(REPO_ROOT, "config", "users", secondUserId);
  const firstProfilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${firstUserId}.yaml`);
  const secondProfilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${secondUserId}.yaml`);

  try {
    await createUserCommand([firstUserId, "--name", "Scope A", "--email", `${firstUserId}@polaris.local`]);
    await createUserCommand([secondUserId, "--name", "Scope B", "--email", `${secondUserId}@polaris.local`]);
    await createCommand([workspace, "--user", firstUserId]);

    const firstSpecPath = path.join(firstUserRoot, "workspaces", workspace, "docker.agent.yaml");
    const secondWorkspaceRoot = path.join(secondUserRoot, "workspaces", workspace);
    const secondSpecPath = path.join(secondWorkspaceRoot, "docker.agent.yaml");
    const firstSpec = (yaml.load(fs.readFileSync(firstSpecPath, "utf8")) ?? {}) as Record<string, unknown>;
    const firstCredentials = typeof firstSpec.credentials === "object" && firstSpec.credentials
      ? { ...(firstSpec.credentials as Record<string, unknown>) }
      : {};
    firstSpec.credentials = {
      ...firstCredentials,
      bindings: [
        { purpose: "agent-auth", credentialId: "scope-a-codex", required: true },
        { purpose: "git-auth", credentialId: "github-ssh", required: false },
      ],
    };
    firstSpec.agent = {
      ...(typeof firstSpec.agent === "object" && firstSpec.agent ? firstSpec.agent as Record<string, unknown> : {}),
      kind: "multi",
      persist_state: true,
    };
    fs.writeFileSync(firstSpecPath, yaml.dump(firstSpec, { lineWidth: 120, noRefs: true }), "utf8");

    fs.mkdirSync(secondWorkspaceRoot, { recursive: true });
    const secondSpec = JSON.parse(JSON.stringify(firstSpec)) as Record<string, unknown>;
    secondSpec.user_profile = secondUserId;
    secondSpec.credentials = {
      bindings: [
        { purpose: "git-auth", credentialId: "github-ssh", required: false },
      ],
    };
    secondSpec.agent = {
      ...(typeof secondSpec.agent === "object" && secondSpec.agent ? secondSpec.agent as Record<string, unknown> : {}),
      kind: "disabled",
      persist_state: false,
    };
    fs.writeFileSync(secondSpecPath, yaml.dump(secondSpec, { lineWidth: 120, noRefs: true }), "utf8");

    await withPortalServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/users/${encodeURIComponent(secondUserId)}/workspaces/${encodeURIComponent(workspace)}`,
      );
      const bodyText = await response.text();
      assert.equal(response.status, 200, bodyText);
      const payload = JSON.parse(bodyText) as {
        credentialBindings: Array<{ purpose: string; credentialId: string; required: boolean }>;
      };
      assert.deepEqual(payload.credentialBindings, [
        { purpose: "git-auth", credentialId: "github-ssh", required: false },
      ]);
    });
  } finally {
    fs.rmSync(firstProfilePath, { force: true });
    fs.rmSync(secondProfilePath, { force: true });
    fs.rmSync(firstUserRoot, { recursive: true, force: true });
    fs.rmSync(secondUserRoot, { recursive: true, force: true });
  }
});

test("portal API can provision the same workspace name for a different user", async () => {
  const workspace = uniqueName("portal-shared-name");
  const firstUserId = uniqueName("portal-shared-a");
  const secondUserId = uniqueName("portal-shared-b");
  const firstUserRoot = path.join(REPO_ROOT, "config", "users", firstUserId);
  const secondUserRoot = path.join(REPO_ROOT, "config", "users", secondUserId);
  const firstProfilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${firstUserId}.yaml`);
  const secondProfilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${secondUserId}.yaml`);

  try {
    await createUserCommand([firstUserId, "--name", "Shared A", "--email", `${firstUserId}@polaris.local`]);
    await createUserCommand([secondUserId, "--name", "Shared B", "--email", `${secondUserId}@polaris.local`]);
    await createCommand([workspace, "--user", firstUserId]);

    await withFakePath(
      {
        docker: "#!/bin/sh\nif [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi\nif [ \"$1\" = \"pull\" ]; then exit 0; fi\nexit 0\n",
      },
      async () => {
        await withPortalServer(async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/users/${secondUserId}/workspaces`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceName: workspace,
              defaultDockerOnly: true,
              startAfterCreate: false,
            }),
          });
          const bodyText = await response.text();
          assert.equal(response.status, 202, bodyText);
        });

        const finalProgress = await waitForProvisionDone(secondUserId, workspace);
        assert.equal(finalProgress.phase, "done", finalProgress.message);
        assert.equal(finalProgress.done, true, finalProgress.message);
        assert.equal(
          fs.existsSync(path.join(secondUserRoot, "workspaces", workspace, "docker.agent.yaml")),
          true,
        );
      },
    );
  } finally {
    clearWorkspaceProvisionProgress(secondUserId, workspace);
    fs.rmSync(firstProfilePath, { force: true });
    fs.rmSync(secondProfilePath, { force: true });
    fs.rmSync(firstUserRoot, { recursive: true, force: true });
    fs.rmSync(secondUserRoot, { recursive: true, force: true });
  }
});

test("portal API previews workspace asset content", async () => {
  await withPortalServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/users/${DEMO_USER_ID}/workspaces/demo/preview?path=${encodeURIComponent("config/users/100000000000000001/workspaces/demo/docker.agent.yaml")}`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      path: string;
      content: string;
      truncated: boolean;
    };
    assert.equal(payload.path, "config/users/100000000000000001/workspaces/demo/docker.agent.yaml");
    assert.match(payload.content, /backend:/);
    assert.equal(payload.truncated, false);
  });
});

test("portal API creates a user profile and Clerk mapping via the CLI-backed flow", async () => {
  const userProfileId = uniqueName("portal-user");
  const clerkUsername = uniqueName("clerk-user");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;

  try {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userProfileId,
          clerkUsername,
          name: "Portal Test User",
          email: `${userProfileId}@polaris.local`,
          role: "user",
          plan: "free",
        }),
      });
      assert.equal(response.status, 201);
      const created = await response.json() as { id: string; name: string; email: string };
      assert.equal(created.id, userProfileId);
      assert.equal(created.name, "Portal Test User");
      assert.equal(created.email, `${userProfileId}@polaris.local`);
    });

    assert.equal(fs.existsSync(profilePath), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "github-ssh.yaml")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "github-ssh", "id_ed25519")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "github-ssh", "id_ed25519.pub")), true);

    const userMap = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
      users?: Record<string, { polarisUserId: string; role: string; plan: string }>;
    };
    assert.equal(userMap.users?.[clerkUsername]?.polarisUserId, userProfileId);
    assert.equal(userMap.users?.[clerkUsername]?.role, "user");
    assert.equal(userMap.users?.[clerkUsername]?.plan, "free");
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal API creates a user profile without a Clerk email by using a synthetic fallback email", async () => {
  const userProfileId = uniqueName("portal-no-email");
  const clerkUsername = uniqueName("clerk-no-email");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;

  try {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userProfileId,
          clerkUsername,
          name: "Portal No Email User",
          role: "user",
          plan: "free",
        }),
      });
      assert.equal(response.status, 201);
      const created = await response.json() as { id: string; email: string };
      assert.equal(created.id, userProfileId);
      assert.equal(created.email, `${userProfileId}@polaris.local`);
    });

    assert.equal(fs.existsSync(profilePath), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "github-ssh.yaml")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "github-ssh", "id_ed25519")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "github-ssh", "id_ed25519.pub")), true);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal API creates the default RightCode codex credential when configured", async () => {
  const previous = process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY;
  process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY = "test-default-rightcode-key";
  const userProfileId = uniqueName("portal-codex-default");
  const clerkUsername = uniqueName("clerk-codex-default");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;

  try {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userProfileId,
          clerkUsername,
          name: "Portal Codex Default User",
          email: `${userProfileId}@polaris.local`,
          role: "user",
          plan: "free",
        }),
      });
      assert.equal(response.status, 201);
    });

    assert.equal(fs.existsSync(profilePath), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "github-ssh.yaml")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "codex-rightcode.yaml")), true);
  } finally {
    if (previous === undefined) {
      delete process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY;
    } else {
      process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY = previous;
    }
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});


test("portal API resolves Clerk username mappings from the live mapping file", async () => {
  const clerkUsername = uniqueName("clerk-map");
  const userProfileId = uniqueName("portal-map-user");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;

  try {
    await createUserCommand([
      userProfileId,
      "--name",
      "Portal Mapping User",
      "--email",
      `${userProfileId}@polaris.local`,
      "--clerk",
      clerkUsername,
    ]);

    await withPortalServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/user-mapping?clerkUsername=${encodeURIComponent(clerkUsername)}`,
      );
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        clerkUsername: string;
        mapping: { polarisUserId: string; role: string; plan: string } | null;
      };
      assert.equal(payload.clerkUsername, clerkUsername);
      assert.equal(payload.mapping?.polarisUserId, userProfileId);
      assert.equal(payload.mapping?.role, "user");
      assert.equal(payload.mapping?.plan, "free");
    });
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal API rejects conflicting Clerk username registrations", async () => {
  const clerkUsername = uniqueName("clerk-conflict");
  const firstUserId = uniqueName("portal-conflict-a");
  const secondUserId = uniqueName("portal-conflict-b");
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  const cleanupTargets = [firstUserId, secondUserId].map((userId) => ({
    profilePath: path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`),
    userRoot: path.join(REPO_ROOT, "config", "users", userId),
  }));

  try {
    await createUserCommand([
      firstUserId,
      "--name",
      "Conflict A",
      "--email",
      `${firstUserId}@polaris.local`,
      "--clerk",
      clerkUsername,
    ]);

    await withPortalServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userProfileId: secondUserId,
          clerkUsername,
          name: "Conflict B",
          email: `${secondUserId}@polaris.local`,
          role: "user",
          plan: "free",
        }),
      });
      assert.equal(response.status, 409);
      const payload = await response.json() as { error: string };
      assert.match(payload.error, /already mapped/i);
    });
  } finally {
    for (const target of cleanupTargets) {
      fs.rmSync(target.profilePath, { force: true });
      fs.rmSync(target.userRoot, { recursive: true, force: true });
    }
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal API provisions a new workspace through the CLI-backed scaffold flow", async () => {
  const userId = uniqueName("portal-workspace-user");
  const workspace = uniqueName("portal-create");
  const workspaceRoot = path.join(REPO_ROOT, "config", "users", userId, "workspaces", workspace);
  const profileFile = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
  const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
  const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
  const privateKey = path.join(userRoot, "credentials", "ssh", "id_ed25519");
  const publicKey = path.join(userRoot, "credentials", "ssh", "id_ed25519.pub");
  try {
    await createUserCommand([userId, "--name", "Portal Workspace User", "--email", `${userId}@polaris.local`]);
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.mkdirSync(path.dirname(privateKey), { recursive: true });
    fs.writeFileSync(codexAuth, "{}\n", "utf8");
    fs.writeFileSync(codexConfig, "model = 'gpt-5'\n", "utf8");
    fs.writeFileSync(claudeSettings, "{}\n", "utf8");
    fs.writeFileSync(privateKey, "dummy-private-key\n", "utf8");
    fs.writeFileSync(
      publicKey,
      `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey ${userId}@polaris.local\n`,
      "utf8",
    );
    writeWorkspaceProvisionProgress(userId, workspace, {
      userId,
      workspace,
      phase: "error",
      step: 6,
      totalSteps: 7,
      percent: 86,
      message: "stale failure",
      updatedAt: new Date().toISOString(),
      done: true,
      error: "stale failure",
    });

    await withFakePath(
      {
        docker: "#!/bin/sh\nif [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi\nif [ \"$1\" = \"pull\" ]; then exit 0; fi\nexit 0\n",
      },
      async () => {
        await withPortalServer(async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceName: workspace }),
          });
          const bodyText = await response.text();
          assert.equal(response.status, 202, bodyText);
          const payload = JSON.parse(bodyText) as {
            workspace: string;
            phase: string;
            done: boolean;
            error?: string;
            percent: number;
          };
          assert.equal(payload.workspace, workspace);
          assert.equal(payload.phase, "queued");
          assert.equal(payload.done, false);
          assert.equal(payload.error, undefined);
          assert.equal(payload.percent, 0);
        });
        const finalProgress = await waitForProvisionDone(userId, workspace);
        assert.equal(finalProgress.phase, "done", finalProgress.message);
        assert.equal(finalProgress.done, true, finalProgress.message);
      },
    );

    const workspaceStatusPath = path.join(workspaceRoot, "state", "status.json");
    assert.equal(fs.existsSync(workspaceStatusPath), true);
    const finalStatus = JSON.parse(fs.readFileSync(workspaceStatusPath, "utf8")) as {
      state?: string;
      backend?: { instanceState?: string };
    };
    assert.equal(finalStatus.state, "not-applied");
    assert.equal(finalStatus.backend?.instanceState, "missing");

    assert.equal(fs.existsSync(path.join(workspaceRoot, "docker.agent.yaml")), true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "pod.agent.yaml")), true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "kubevirt.agent.yaml")), true);

    const profileAfter = (yaml.load(fs.readFileSync(profileFile, "utf8")) ?? {}) as { workspaces?: string[] };
    assert.ok(profileAfter.workspaces?.includes(workspace));
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    clearWorkspaceProvisionProgress(userId, workspace);
    fs.rmSync(codexAuth, { force: true });
    fs.rmSync(codexConfig, { force: true });
    fs.rmSync(claudeSettings, { force: true });
    fs.rmSync(privateKey, { force: true });
    fs.rmSync(publicKey, { force: true });
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal API can cancel a queued or running workspace provision job", async () => {
  const userId = uniqueName("portal-cancel-user");
  const workspace = uniqueName("portal-cancel");
  const workspaceRoot = path.join(REPO_ROOT, "config", "users", userId, "workspaces", workspace);
  const profileFile = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
  const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
  const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
  const privateKey = path.join(userRoot, "credentials", "ssh", "id_ed25519");
  const publicKey = path.join(userRoot, "credentials", "ssh", "id_ed25519.pub");

  try {
    await createUserCommand([userId, "--name", "Portal Cancel User", "--email", `${userId}@polaris.local`]);
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.mkdirSync(path.dirname(privateKey), { recursive: true });
    fs.writeFileSync(codexAuth, "{}\n", "utf8");
    fs.writeFileSync(codexConfig, "model = 'gpt-5'\n", "utf8");
    fs.writeFileSync(claudeSettings, "{}\n", "utf8");
    fs.writeFileSync(privateKey, "dummy-private-key\n", "utf8");
    fs.writeFileSync(
      publicKey,
      `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey ${userId}@polaris.local\n`,
      "utf8",
    );

    await withEnv("POLARIS_TEST_PROVISION_STEP_DELAY_MS", "250", async () => {
      await withFakePath(
        {
          docker: "#!/bin/sh\nif [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi\nif [ \"$1\" = \"pull\" ]; then exit 0; fi\nexit 0\n",
        },
        async () => {
          await withPortalServer(async (baseUrl) => {
            const createResponse = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspaceName: workspace }),
            });
            assert.equal(createResponse.status, 202);

            const cancelResponse = await fetch(
              `${baseUrl}/api/users/${userId}/workspaces/${workspace}/provision/cancel`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
              },
            );
            assert.equal(cancelResponse.status, 200);
          });

          const finalProgress = await waitFor(() => {
            const progress = readWorkspaceProvisionProgress(userId, workspace);
            return progress?.done ? progress : null;
          }, { timeoutMs: 10000 });
          assert.equal(finalProgress.status, "cancelled");
          assert.equal(finalProgress.phase, "cancelled");
          assert.equal(finalProgress.errorCode, "workspace-provision-cancelled");
          assert.equal(finalProgress.retryable, true);
        },
      );
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    clearWorkspaceProvisionProgress(userId, workspace);
    fs.rmSync(codexAuth, { force: true });
    fs.rmSync(codexConfig, { force: true });
    fs.rmSync(claudeSettings, { force: true });
    fs.rmSync(privateKey, { force: true });
    fs.rmSync(publicKey, { force: true });
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal API stops the selected workspace driver", async () => {
  const userId = uniqueName("portal-stop-user");
  const workspace = uniqueName("portal-stop");
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const workspaceRoot = path.join(userRoot, "workspaces", workspace);
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
  const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
  const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
  const privateKey = path.join(userRoot, "credentials", "ssh", "id_ed25519");
  const publicKey = path.join(userRoot, "credentials", "ssh", "id_ed25519.pub");

  try {
    await createUserCommand([userId, "--name", "Portal Stop User", "--email", `${userId}@polaris.local`]);
    await createCommand([workspace, "--user", userId]);
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.mkdirSync(path.dirname(privateKey), { recursive: true });
    fs.writeFileSync(codexAuth, "{}\n", "utf8");
    fs.writeFileSync(codexConfig, "model = 'gpt-5'\n", "utf8");
    fs.writeFileSync(claudeSettings, "{}\n", "utf8");
    fs.writeFileSync(privateKey, "dummy-private-key\n", "utf8");
    fs.writeFileSync(
      publicKey,
      `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey ${userId}@polaris.local\n`,
      "utf8",
    );
    writeWorkspaceDriverSelection(workspace, { backend: "docker" }, userId);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "compose" && "$4" == "stop" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then
  printf 'portal-stop-id'
  exit 0
fi
if [[ "$1" == "inspect" && "$2" == "portal-stop-id" ]]; then
  printf '[{"State":{"Running":false}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  exit 0
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        await withPortalServer(async (baseUrl) => {
          const response = await fetch(
            `${baseUrl}/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/stop`,
            { method: "POST" },
          );
          const bodyText = await response.text();
          assert.equal(response.status, 200, bodyText);
          const payload = JSON.parse(bodyText) as { stopped: boolean };
          assert.equal(payload.stopped, true);
        });
        const commandLog = readCommandLog();
        assert.ok(commandLog.some((entry) => entry.includes("compose") && entry.includes("stop")));
        assert.ok(commandLog.some((entry) => entry.includes("compose") && entry.includes("ps")));
        assert.ok(commandLog.some((entry) => entry.includes("inspect portal-stop-id")));
      },
    );
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    fs.rmSync(privateKey, { force: true });
    fs.rmSync(publicKey, { force: true });
  }
});

test("portal API can create and start a new workspace in one flow", async () => {
  const userId = uniqueName("portal-start-user");
  const workspace = uniqueName("portal-start");
  const workspaceRoot = path.join(REPO_ROOT, "config", "users", userId, "workspaces", workspace);
  const profileFile = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);

  try {
    await createUserCommand([userId, "--name", "Portal Start User", "--email", `${userId}@polaris.local`]);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi
if [[ "$1" == "pull" ]]; then exit 0; fi
if [[ "$1" == "volume" && "$2" == "inspect" ]]; then exit 1; fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then printf 'docker-started-id'; exit 0; fi
if [[ "$1" == "inspect" && "$2" == "docker-started-id" ]]; then printf '[{"State":{"Running":true}}]'; exit 0; fi
if [[ "$1" == "exec" ]]; then
  if [[ "$5" == *"paseo daemon status --json"* ]]; then
    printf '{"serverId":"srv_portal_start","localDaemon":"running","connectedDaemon":"reachable"}'
    exit 0
  fi
  if [[ "$5" == *"paseo daemon pair --json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJzZXJ2ZXJJZCI6InNydl9wb3J0YWxfc3RhcnQifQ"}'
    exit 0
  fi
  if [[ "$5" == *"/server-id"* ]]; then
    printf 'srv_portal_start'
    exit 0
  fi
  exit 0
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        await withPortalServer(async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceName: workspace,
              defaultDockerOnly: true,
              startAfterCreate: true,
            }),
          });
          const bodyText = await response.text();
          assert.equal(response.status, 202, bodyText);
        });

        const finalProgress = await waitForProvisionDone(userId, workspace);
        assert.equal(finalProgress.phase, "done", finalProgress.message);
        assert.equal(finalProgress.done, true, finalProgress.message);
        assert.ok(
          readCommandLog().some((entry) => entry.includes("compose") && entry.includes("up") && entry.includes("-d")),
        );
        assert.ok(
          readCommandLog().some((entry) => entry.includes("paseo daemon status --json")),
        );
        assert.ok(
          readCommandLog().some((entry) => entry.includes("paseo daemon pair --json")),
        );
      },
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    clearWorkspaceProvisionProgress(userId, workspace);
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal API starts the selected workspace driver", async () => {
  const userId = uniqueName("portal-explicit-start-user");
  const workspace = uniqueName("portal-explicit-start");
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const workspaceRoot = path.join(userRoot, "workspaces", workspace);
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
  const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
  const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
  const privateKey = path.join(userRoot, "credentials", "ssh", "id_ed25519");
  const publicKey = path.join(userRoot, "credentials", "ssh", "id_ed25519.pub");

  try {
    await createUserCommand([userId, "--name", "Portal Explicit Start User", "--email", `${userId}@polaris.local`]);
    await createCommand([workspace, "--user", userId]);
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.mkdirSync(path.dirname(privateKey), { recursive: true });
    fs.writeFileSync(codexAuth, "{}\n", "utf8");
    fs.writeFileSync(codexConfig, "model = 'gpt-5'\n", "utf8");
    fs.writeFileSync(claudeSettings, "{}\n", "utf8");
    fs.writeFileSync(privateKey, "dummy-private-key\n", "utf8");
    fs.writeFileSync(
      publicKey,
      `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey ${userId}@polaris.local\n`,
      "utf8",
    );
    writeWorkspaceDriverSelection(workspace, { backend: "docker" }, userId);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "compose" && "$4" == "up" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then
  printf 'portal-start-id'
  exit 0
fi
if [[ "$1" == "inspect" && "$2" == "portal-start-id" ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  if [[ "$5" == *"paseo daemon status --json"* ]]; then
    printf '{"serverId":"srv_portal_explicit_start","localDaemon":"running","connectedDaemon":"reachable"}'
    exit 0
  fi
  if [[ "$5" == *"paseo daemon pair --json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9wb3J0YWxfZXhwbGljaXRfc3RhcnQifQ"}'
    exit 0
  fi
  if [[ "$5" == *"/server-id"* ]]; then
    printf 'srv_portal_explicit_start'
    exit 0
  fi
  exit 0
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        await withPortalServer(async (baseUrl) => {
          const response = await fetch(
            `${baseUrl}/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/start`,
            { method: "POST" },
          );
          const bodyText = await response.text();
          assert.equal(response.status, 200, bodyText);
          const payload = JSON.parse(bodyText) as { started: boolean };
          assert.equal(payload.started, true);

          const detailResponse = await fetch(
            `${baseUrl}/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}`,
          );
          const detailText = await detailResponse.text();
          assert.equal(detailResponse.status, 200, detailText);
          const detailPayload = JSON.parse(detailText) as {
            liveTarget?: string | null;
            status?: { paseo?: { liveTarget?: string | null } };
          };
          const effectiveLiveTarget =
            detailPayload.liveTarget
            ?? detailPayload.status?.paseo?.liveTarget
            ?? null;
          assert.equal(
            effectiveLiveTarget ? new URL(effectiveLiveTarget).searchParams.get("scope") : null,
            `${userId}:${workspace}`,
          );
        });
        const commandLog = readCommandLog();
        assert.ok(commandLog.some((entry) => entry.includes("compose") && entry.includes("up") && entry.includes("-d")));
        assert.ok(commandLog.some((entry) => entry.includes("paseo daemon status --json")));
        assert.ok(commandLog.some((entry) => entry.includes("paseo daemon pair --json")));
      },
    );
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    fs.rmSync(privateKey, { force: true });
    fs.rmSync(publicKey, { force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("portal API binds and unbinds paseo agent credentials on the selected workspace driver", async () => {
  const userId = uniqueName("portal-paseo-bind-user");
  const workspace = uniqueName("portal-paseo-bind");
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const workspaceRoot = path.join(userRoot, "workspaces", workspace);
  const profileFile = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const dockerSpecPath = path.join(workspaceRoot, "docker.agent.yaml");
  const credentialId = uniqueName("portal-codex");

  try {
    await createUserCommand([userId, "--name", "Portal Paseo Bind User", "--email", `${userId}@polaris.local`]);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi
if [[ "$1" == "pull" ]]; then exit 0; fi
if [[ "$1" == "volume" && "$2" == "inspect" ]]; then exit 1; fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then printf 'docker-bind-id'; exit 0; fi
if [[ "$1" == "inspect" && "$2" == "docker-bind-id" ]]; then printf '[{"State":{"Running":true}}]'; exit 0; fi
if [[ "$1" == "exec" ]]; then
  if [[ "$5" == *"paseo daemon status --json"* ]]; then
    printf '{"serverId":"srv_test","localDaemon":"running","connectedDaemon":"reachable"}'
    exit 0
  fi
  if [[ "$5" == *"paseo daemon pair --json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJzZXJ2ZXJJZCI6InNydl90ZXN0In0"}'
    exit 0
  fi
  if [[ "$5" == *"/server-id"* ]]; then
    printf 'srv_test'
    exit 0
  fi
  if [[ "$5" == *"/pairing.json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJzZXJ2ZXJJZCI6InNydl90ZXN0In0"}'
    exit 0
  fi
  exit 0
fi
exit 0
`,
      },
      async () => {
        await withPortalServer(async (baseUrl) => {
          const createWorkspaceResponse = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceName: workspace,
              defaultDockerOnly: true,
              startAfterCreate: true,
            }),
          });
          const createWorkspaceBody = await createWorkspaceResponse.text();
          assert.equal(createWorkspaceResponse.status, 202, createWorkspaceBody);

          const finalProgress = await waitForProvisionDone(userId, workspace);
          assert.equal(finalProgress.phase, "done", finalProgress.message);
          assert.equal(finalProgress.done, true, finalProgress.message);

          const createCredentialResponse = await fetch(`${baseUrl}/api/users/${userId}/credentials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              harness: "codex",
              credentialId,
              label: "Portal Bind Credential",
              providerName: "test-provider",
              baseUrl: "https://example.invalid/codex/v1",
              apiKey: "test-api-key",
            }),
          });
          const createCredentialBody = await createCredentialResponse.text();
          assert.equal(createCredentialResponse.status, 201, createCredentialBody);

          const bindResponse = await fetch(
            `${baseUrl}/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/paseo/bind`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                driver: "docker",
                credentialId,
              }),
            },
          );
          const bindBody = await bindResponse.text();
          assert.equal(bindResponse.status, 200, bindBody);
          const bindPayload = JSON.parse(bindBody) as {
            enabled: boolean;
            restarted: boolean;
            credentialBindings: Array<{ purpose: string; credentialId: string; required: boolean }>;
          };
          assert.equal(bindPayload.enabled, true);
          assert.equal(bindPayload.restarted, true);
          assert.deepEqual(bindPayload.credentialBindings, [
            { purpose: "agent-auth", credentialId, required: true },
            { purpose: "git-auth", credentialId: "github-ssh", required: false },
          ]);

          const boundSpec = (yaml.load(fs.readFileSync(dockerSpecPath, "utf8")) ?? {}) as {
            agent?: { kind?: string; persist_state?: boolean };
            credentials?: { bindings?: Array<{ purpose?: string; credentialId?: string; required?: boolean }> };
          };
          assert.deepEqual(boundSpec.credentials?.bindings, [
            { purpose: "agent-auth", credentialId, required: true },
            { purpose: "git-auth", credentialId: "github-ssh", required: false },
          ]);

          const unbindResponse = await fetch(
            `${baseUrl}/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/paseo/unbind`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                driver: "docker",
              }),
            },
          );
          const unbindBody = await unbindResponse.text();
          assert.equal(unbindResponse.status, 200, unbindBody);
          const unbindPayload = JSON.parse(unbindBody) as {
            enabled: boolean;
            restarted: boolean;
            credentialBindings: Array<{ purpose: string; credentialId: string; required: boolean }>;
          };
          assert.equal(unbindPayload.enabled, false);
          assert.equal(unbindPayload.restarted, true);
          assert.deepEqual(unbindPayload.credentialBindings, [
            { purpose: "git-auth", credentialId: "github-ssh", required: false },
          ]);

          const unboundSpec = (yaml.load(fs.readFileSync(dockerSpecPath, "utf8")) ?? {}) as {
            agent?: { kind?: string; persist_state?: boolean };
            credentials?: { bindings?: Array<{ purpose?: string; credentialId?: string; required?: boolean }> };
          };
          assert.deepEqual(unboundSpec.credentials?.bindings, [
            { purpose: "git-auth", credentialId: "github-ssh", required: false },
          ]);
        });
      },
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    clearWorkspaceProvisionProgress(userId, workspace);
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal API switches the live codex credential without mutating workspace bindings", async () => {
  const userId = uniqueName("portal-live-switch-user");
  const workspace = uniqueName("portal-live-switch");
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const workspaceRoot = path.join(userRoot, "workspaces", workspace);
  const profileFile = path.join(
    REPO_ROOT,
    "config",
    "users",
    "profiles",
    `${userId}.yaml`,
  );
  const liveStatePath = path.join(workspaceRoot, "state", "live-credentials.json");

  try {
    await createUserCommand([
      userId,
      "--name",
      "Portal Live Switch User",
      "--email",
      `${userId}@polaris.local`,
    ]);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi
if [[ "$1" == "pull" ]]; then exit 0; fi
if [[ "$1" == "volume" && "$2" == "inspect" ]]; then exit 1; fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then printf 'docker-live-switch'; exit 0; fi
if [[ "$1" == "inspect" && "$2" == "docker-live-switch" ]]; then printf '[{"State":{"Running":true}}]'; exit 0; fi
if [[ "$1" == "exec" ]]; then
  if [[ "$3" == "sh" && "$4" == "-lc" ]]; then
    printf '%s\n' "$5" >> ${JSON.stringify(path.join(os.tmpdir(), "portal-live-switch-script.log"))}
    if [[ "$5" == *"paseo daemon status --json"* ]]; then
      printf '{"serverId":"srv_test","localDaemon":"running","connectedDaemon":"reachable"}'
      exit 0
    fi
    if [[ "$5" == *"paseo daemon pair --json"* ]]; then
      printf '{"url":"https://app.paseo.test/#offer=eyJzZXJ2ZXJJZCI6InNydl90ZXN0In0"}'
      exit 0
    fi
    if [[ "$5" == *"/server-id"* ]]; then
      printf 'srv_test'
      exit 0
    fi
    exit 0
  fi
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        const scriptLogPath = path.join(os.tmpdir(), "portal-live-switch-script.log");
        fs.rmSync(scriptLogPath, { force: true });

        await withPortalServer(async (baseUrl) => {
          const createWorkspaceResponse = await fetch(
            `${baseUrl}/api/users/${userId}/workspaces`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                workspaceName: workspace,
                defaultDockerOnly: true,
                startAfterCreate: true,
              }),
            },
          );
          assert.equal(createWorkspaceResponse.status, 202);
          await waitForProvisionDone(userId, workspace);

          const createCredentialResponse = await fetch(
            `${baseUrl}/api/users/${userId}/credentials`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                harness: "codex",
                credentialId: "codex-live",
                label: "Live Switch",
                providerName: "rightcode",
                baseUrl: "https://right.codes/codex/v1",
                apiKey: "test-api-key",
              }),
            },
          );
          assert.equal(createCredentialResponse.status, 201);

          const createClaudeCredentialResponse = await fetch(
            `${baseUrl}/api/users/${userId}/credentials`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                harness: "claude",
                credentialId: "claude-live",
                label: "Claude Live",
                providerName: "anthropic",
                apiKey: "claude-api-key",
              }),
            },
          );
          assert.equal(createClaudeCredentialResponse.status, 201);

          const switchResponse = await fetch(
            `${baseUrl}/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/paseo/credentials/switch`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                harness: "codex",
                credentialId: "codex-live",
              }),
            },
          );
          const switchBody = await switchResponse.text();
          assert.equal(switchResponse.status, 200, switchBody);
          const payload = JSON.parse(switchBody) as {
            switched: boolean;
            harness: string;
            credential: { id: string };
          };
          assert.equal(payload.switched, true);
          assert.equal(payload.harness, "codex");
          assert.equal(payload.credential.id, "codex-live");

          const switchClaudeResponse = await fetch(
            `${baseUrl}/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/paseo/credentials/switch`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                harness: "claude",
                credentialId: "claude-live",
              }),
            },
          );
          const switchClaudeBody = await switchClaudeResponse.text();
          assert.equal(switchClaudeResponse.status, 200, switchClaudeBody);
          const claudePayload = JSON.parse(switchClaudeBody) as {
            switched: boolean;
            harness: string;
            credential: { id: string };
          };
          assert.equal(claudePayload.switched, true);
          assert.equal(claudePayload.harness, "claude");
          assert.equal(claudePayload.credential.id, "claude-live");
        });

        const liveState = JSON.parse(fs.readFileSync(liveStatePath, "utf8")) as {
          codex?: { credentialId?: string };
          claude?: { credentialId?: string };
        };
        assert.equal(liveState.codex?.credentialId, "codex-live");
        assert.equal(liveState.claude?.credentialId, "claude-live");
        assert.equal(
          fs.readFileSync(path.join(workspaceRoot, "docker.agent.yaml"), "utf8").includes("codex-live"),
          false,
        );
        const commandLog = readCommandLog();
        assert.ok(
          commandLog.some((line) => line.includes("exec docker-live-switch sh -lc")),
        );
        assert.match(
          fs.readFileSync(scriptLogPath, "utf8"),
          /\/identity\/codex\/auth\.json/,
        );
        assert.match(
          fs.readFileSync(scriptLogPath, "utf8"),
          /\/identity\/claude\/credential\.json/,
        );
      },
    );
  } finally {
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    clearWorkspaceProvisionProgress(userId, workspace);
  }
});

test("portal API deletes a stopped workspace and removes it from the profile index", async () => {
  const userId = DEMO_USER_ID;
  const workspace = uniqueName("portal-delete");
  const workspaceRoot = path.join(REPO_ROOT, "config", "users", userId, "workspaces", workspace);
  const portalStateRoot = path.join(
    REPO_ROOT,
    "config",
    "users",
    userId,
    ".portal",
    "workspaces",
    workspace,
  );
  const profileFile = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const originalProfile = fs.readFileSync(profileFile, "utf8");
  const profileData = (yaml.load(originalProfile) ?? {}) as Record<string, unknown>;
  const workspaces = Array.isArray(profileData.workspaces)
    ? profileData.workspaces.map((value) => String(value)).filter(Boolean)
    : [];

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(portalStateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(portalStateRoot, "provision.json"),
    JSON.stringify({
      userId,
      workspace,
      phase: "error",
      step: 6,
      totalSteps: 7,
      percent: 86,
      message: "stale failure",
      updatedAt: new Date().toISOString(),
      done: true,
      error: "stale failure",
    }, null, 2) + "\n",
    "utf8",
  );
  profileData.workspaces = [...workspaces, workspace].sort();
  fs.writeFileSync(profileFile, yaml.dump(profileData, { lineWidth: 120, noRefs: true }), "utf8");

  try {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/users/${userId}/workspaces/${workspace}`,
        { method: "DELETE" },
      );
      assert.equal(response.status, 200);
      const payload = await response.json() as { removed: boolean };
      assert.equal(payload.removed, true);
    });

    assert.equal(fs.existsSync(workspaceRoot), false);
    assert.equal(fs.existsSync(portalStateRoot), false);
    const profileAfter = (yaml.load(fs.readFileSync(profileFile, "utf8")) ?? {}) as Record<string, unknown>;
    const remaining = Array.isArray(profileAfter.workspaces)
      ? profileAfter.workspaces.map((value) => String(value))
      : [];
    assert.equal(remaining.includes(workspace), false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.writeFileSync(profileFile, originalProfile, "utf8");
  }
});

test("portal root advertises the API surface and default user", async () => {
  await withPortalServer(async (baseUrl) => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      service: string;
      defaultUserId: string | null;
      endpoints: string[];
    };
    assert.equal(payload.service, "polaris-portal-api");
    assert.equal(payload.defaultUserId, "100000000000000001");
    assert.ok(payload.endpoints.includes("/api/users/:userId/workspaces"));
  });
});

test("portal API restricts normal users to their own scope when trusted auth headers are enabled", async () => {
  await withPortalAuthEnv("test-secret", async () => {
    await withSyntheticMemberUser(async (userId) => {
      await withPortalServer(async (baseUrl) => {
        const ownResponse = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
          headers: {
            "x-polaris-auth-shared-secret": "test-secret",
            "x-polaris-user-id": userId,
            "x-polaris-user-role": "user",
            "x-polaris-user-email": `${userId}@polaris.local`,
            "x-polaris-user-plan": "free",
          },
        });
        assert.equal(ownResponse.status, 200);

        const crossResponse = await fetch(`${baseUrl}/api/users/${DEMO_USER_ID}/workspaces`, {
          headers: {
            "x-polaris-auth-shared-secret": "test-secret",
            "x-polaris-user-id": userId,
            "x-polaris-user-role": "user",
            "x-polaris-user-email": `${userId}@polaris.local`,
            "x-polaris-user-plan": "free",
          },
        });
        assert.equal(crossResponse.status, 403);
      });
    });
  });
});

test("portal API allows admin users to access cross-user scopes when trusted auth headers are enabled", async () => {
  await withPortalAuthEnv("test-secret", async () => {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users/100000000000000001/workspaces`, {
        headers: {
          "x-polaris-auth-shared-secret": "test-secret",
          "x-polaris-user-id": "100000000000000001",
          "x-polaris-user-role": "admin",
          "x-polaris-user-email": "admin@example.com",
        },
      });
      assert.equal(response.status, 200);
      const payload = await response.json() as { workspaces: Array<{ name: string }> };
      assert.ok(payload.workspaces.some((workspace) => workspace.name === "demo"));
    });
  });
});
