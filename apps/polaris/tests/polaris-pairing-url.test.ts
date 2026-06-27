import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadWorkspaceFromConfigPath, resolveWorkspaceConfigPath } from "../scripts/config/load.js";
import { workspaceConfigPath } from "../scripts/config/scaffold.js";
import { generatedOutputPath } from "../scripts/output/write-generated.js";
import { renderAndWriteDockerWorkspace } from "../scripts/backends/docker/render.js";
import { renderAndWritePodWorkspace } from "../scripts/backends/pod/render.js";
import { renderKubevirtWorkspace } from "../scripts/backends/kubevirt/render.js";
import {
  applyPairingUrlScope,
  extractOfferFragment,
  normalizePairingUrl,
} from "../scripts/core/pairing-url.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const DEMO_USER_PROFILE_ID = "100000000000000001";

function loadWorkspaceFromRefForTest(projectRef: string) {
  const resolved = resolveWorkspaceConfigPath(projectRef);
  return loadWorkspaceFromConfigPath(
    resolved.configPath,
    resolved.project,
    resolved.backendHint,
    resolved.profileHint,
  );
}

async function withTempWorkspaceSpec(
  project: string,
  backendKind: "docker" | "pod" | "kubevirt-vm",
  fn: () => Promise<void> | void,
): Promise<void> {
  const outputPath = workspaceConfigPath(project, backendKind, DEMO_USER_PROFILE_ID);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const sourcePath = workspaceConfigPath("demo", backendKind, DEMO_USER_PROFILE_ID);
  const doc = (yaml.load(fs.readFileSync(sourcePath, "utf8")) ?? {}) as Record<string, unknown>;
  doc.project = project;
  doc.backend = {
    ...(typeof doc.backend === "object" && doc.backend ? doc.backend as Record<string, unknown> : {}),
    kind: backendKind,
  };

  fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  const generatedPath = generatedOutputPath(loadWorkspaceFromRefForTest(`${project}@${backendKind}`));
  try {
    await fn();
  } finally {
    fs.rmSync(outputPath, { force: true });
    fs.rmSync(generatedPath, { force: true });
  }
}

test("normalizePairingUrl rewrites the offer onto the configured Paseo app base URL", () => {
  const raw = "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0";
  assert.equal(extractOfferFragment(raw), "eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0");
  assert.equal(
    normalizePairingUrl(raw, {
      POLARIS_PASEO_APP_BASE_URL: "http://portal.example.test:8082/",
    }),
    "http://portal.example.test:8082/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0",
  );
});

test("normalizePairingUrl preserves a user scope on the rewritten Paseo URL", () => {
  const raw = "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zY29wZWQifQ";
  assert.equal(
    normalizePairingUrl(
      raw,
      {
        POLARIS_PASEO_APP_BASE_URL: "https://portal.example.test/paseo/",
      },
      DEMO_USER_PROFILE_ID,
    ),
    `https://portal.example.test/paseo?scope=${DEMO_USER_PROFILE_ID}#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zY29wZWQifQ`,
  );
});

test("applyPairingUrlScope appends scope when the pairing URL is already normalized", () => {
  assert.equal(
    applyPairingUrlScope("https://portal.example.test/paseo/#offer=demo", DEMO_USER_PROFILE_ID),
    `https://portal.example.test/paseo/?scope=${DEMO_USER_PROFILE_ID}#offer=demo`,
  );
});

test("docker render persists the configured Paseo app base URL into the runtime config bootstrap", async () => {
  const previous = process.env.POLARIS_PASEO_APP_BASE_URL;
  process.env.POLARIS_PASEO_APP_BASE_URL = "http://portal.example.test:8082";
  const project = `pairing-docker-${process.pid}-${Date.now()}`;
  try {
    await withTempWorkspaceSpec(project, "docker", async () => {
      const workspace = loadWorkspaceFromRefForTest(`${project}@docker`);
      const rendered = fs.readFileSync(renderAndWriteDockerWorkspace(workspace), "utf8");
      assert.match(rendered, /baseUrl\\"\] = \\"http:\/\/portal\.example\.test:8082\\"/);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.POLARIS_PASEO_APP_BASE_URL;
    } else {
      process.env.POLARIS_PASEO_APP_BASE_URL = previous;
    }
  }
});

test("pod render persists the configured Paseo app base URL into the runtime config bootstrap", async () => {
  const previous = process.env.POLARIS_PASEO_APP_BASE_URL;
  process.env.POLARIS_PASEO_APP_BASE_URL = "http://portal.example.test:8082";
  const project = `pairing-pod-${process.pid}-${Date.now()}`;
  try {
    await withTempWorkspaceSpec(project, "pod", async () => {
      const workspace = loadWorkspaceFromRefForTest(`${project}@pod`);
      const rendered = fs.readFileSync(renderAndWritePodWorkspace(workspace), "utf8");
      assert.match(rendered, /baseUrl\\"\] = \\"http:\/\/portal\.example\.test:8082\\"/);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.POLARIS_PASEO_APP_BASE_URL;
    } else {
      process.env.POLARIS_PASEO_APP_BASE_URL = previous;
    }
  }
});

test("kubevirt render persists the configured Paseo app base URL into cloud-init bootstrap", async () => {
  const previous = process.env.POLARIS_PASEO_APP_BASE_URL;
  process.env.POLARIS_PASEO_APP_BASE_URL = "http://portal.example.test:8082";
  const project = `pairing-vm-${process.pid}-${Date.now()}`;
  try {
    await withTempWorkspaceSpec(project, "kubevirt-vm", async () => {
      const workspace = loadWorkspaceFromRefForTest(`${project}@kubevirt-vm`);
      const rendered = renderKubevirtWorkspace(workspace);
      assert.match(rendered, /data\.setdefault\("app", \{\}\)\["baseUrl"\] = "http:\/\/portal\.example\.test:8082";/);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.POLARIS_PASEO_APP_BASE_URL;
    } else {
      process.env.POLARIS_PASEO_APP_BASE_URL = previous;
    }
  }
});
