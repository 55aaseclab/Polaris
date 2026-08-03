import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadVaultFromConfigPath, resolveVaultConfigPath } from "../scripts/config/load.js";
import {
  scaffoldDockerVault,
  verticalVaultBaseImage,
  vaultConfigPath,
  WANGHAI_BACKUP_RUNTIME_ROOT,
  WANGHAI_CACHE_RUNTIME_ROOT,
  WANGHAI_VAULTS_RUNTIME_ROOT,
} from "../scripts/config/scaffold.js";
import { generatedOutputPath } from "../scripts/output/write-generated.js";
import { renderAndWriteDockerVault } from "../scripts/backends/docker/render.js";
import { renderAndWritePodVault } from "../scripts/backends/pod/render.js";
import { renderKubevirtVault } from "../scripts/backends/kubevirt/render.js";
import {
  applyPairingUrlScope,
  extractOfferFragment,
  normalizePairingUrl,
} from "../scripts/core/pairing-url.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const DEMO_USER_PROFILE_ID = "100000000000000001";

function loadVaultFromRefForTest(projectRef: string) {
  const resolved = resolveVaultConfigPath(projectRef);
  return loadVaultFromConfigPath(
    resolved.configPath,
    resolved.project,
    resolved.backendHint,
    resolved.profileHint,
  );
}

async function withTempVaultSpec(
  project: string,
  backendKind: "docker" | "pod" | "kubevirt-vm",
  fn: () => Promise<void> | void,
): Promise<void> {
  const outputPath = vaultConfigPath(project, backendKind, DEMO_USER_PROFILE_ID);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const sourcePath = vaultConfigPath("demo", backendKind, DEMO_USER_PROFILE_ID);
  const doc = (yaml.load(fs.readFileSync(sourcePath, "utf8")) ?? {}) as Record<string, unknown>;
  doc.project = project;
  doc.backend = {
    ...(typeof doc.backend === "object" && doc.backend ? doc.backend as Record<string, unknown> : {}),
    kind: backendKind,
  };

  fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  const generatedPath = generatedOutputPath(loadVaultFromRefForTest(`${project}@${backendKind}`));
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

test("vertical docker scaffold selects the Wanghai image, surfaces, and dual ports", () => {
  const project = `vertical-scaffold-${process.pid}-${Date.now()}`;
  const outputPath = scaffoldDockerVault(project, DEMO_USER_PROFILE_ID, {
    line: "vertical",
  });
  try {
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as {
      env?: { plain?: Record<string, unknown> };
      runtime?: { base_image?: unknown };
      surfaces?: unknown;
      service?: {
        ports?: Array<{
          container_port?: unknown;
          name?: unknown;
        }>;
      };
    };

    assert.equal(doc.runtime?.base_image, verticalVaultBaseImage());
    assert.deepEqual(doc.surfaces, ["paseo", "wanghai"]);
    assert.deepEqual(doc.env?.plain, {
      WANGHAI_REPO_ROOT: "/opt/wanghai",
      WANGHAI_VAULTS_ROOT: WANGHAI_VAULTS_RUNTIME_ROOT,
      WANGHAI_BACKUP_ROOT: WANGHAI_BACKUP_RUNTIME_ROOT,
      WANGHAI_CACHE_ROOT: WANGHAI_CACHE_RUNTIME_ROOT,
    });
    assert.deepEqual(
      (doc.service?.ports ?? []).map((entry) => ({
        containerPort: String(entry.container_port ?? ""),
        name: String(entry.name ?? ""),
      })),
      [
        { containerPort: "6767", name: "paseo" },
        { containerPort: "9090", name: "wanghai" },
      ],
    );
  } finally {
    fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
  }
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
    await withTempVaultSpec(project, "docker", async () => {
      const vault = loadVaultFromRefForTest(`${project}@docker`);
      const rendered = fs.readFileSync(renderAndWriteDockerVault(vault), "utf8");
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

test("docker render disables default Paseo voice features in the runtime config bootstrap", async () => {
  const project = `pairing-docker-voice-${process.pid}-${Date.now()}`;
  await withTempVaultSpec(project, "docker", async () => {
    const vault = loadVaultFromRefForTest(`${project}@docker`);
    const rendered = fs.readFileSync(renderAndWriteDockerVault(vault), "utf8");
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"dictation\\", {})[\\"enabled\\"] = False'),
    );
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"voiceMode\\", {})[\\"enabled\\"] = False'),
    );
  });
});

test("pod render persists the configured Paseo app base URL into the runtime config bootstrap", async () => {
  const previous = process.env.POLARIS_PASEO_APP_BASE_URL;
  process.env.POLARIS_PASEO_APP_BASE_URL = "http://portal.example.test:8082";
  const project = `pairing-pod-${process.pid}-${Date.now()}`;
  try {
    await withTempVaultSpec(project, "pod", async () => {
      const vault = loadVaultFromRefForTest(`${project}@pod`);
      const rendered = fs.readFileSync(renderAndWritePodVault(vault), "utf8");
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

test("pod render disables default Paseo voice features in the runtime config bootstrap", async () => {
  const project = `pairing-pod-voice-${process.pid}-${Date.now()}`;
  await withTempVaultSpec(project, "pod", async () => {
    const vault = loadVaultFromRefForTest(`${project}@pod`);
    const rendered = fs.readFileSync(renderAndWritePodVault(vault), "utf8");
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"dictation\\", {})[\\"enabled\\"] = False'),
    );
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"voiceMode\\", {})[\\"enabled\\"] = False'),
    );
  });
});

test("kubevirt render persists the configured Paseo app base URL into cloud-init bootstrap", async () => {
  const previous = process.env.POLARIS_PASEO_APP_BASE_URL;
  process.env.POLARIS_PASEO_APP_BASE_URL = "http://portal.example.test:8082";
  const project = `pairing-vm-${process.pid}-${Date.now()}`;
  try {
    await withTempVaultSpec(project, "kubevirt-vm", async () => {
      const vault = loadVaultFromRefForTest(`${project}@kubevirt-vm`);
      const rendered = renderKubevirtVault(vault);
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

test("kubevirt render disables default Paseo voice features in cloud-init bootstrap", async () => {
  const project = `pairing-vm-voice-${process.pid}-${Date.now()}`;
  await withTempVaultSpec(project, "kubevirt-vm", async () => {
    const vault = loadVaultFromRefForTest(`${project}@kubevirt-vm`);
    const rendered = renderKubevirtVault(vault);
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"dictation\\", {})[\\"enabled\\"] = False'),
    );
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"voiceMode\\", {})[\\"enabled\\"] = False'),
    );
  });
});
