import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../scripts/cli/main.js";
import {
  getDomainPackFlowGraphProjection,
  listDomainPackProjections,
  listDomainPacks,
} from "../scripts/config/domain-packs.js";

const FIRST_PARTY_VAULT_KNOWLEDGE_PACK = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "domain-packs",
  "vault-knowledge-health",
);

test("DSL flow projection exposes every declared step and only data dependencies", () => {
  const graph = getDomainPackFlowGraphProjection(
    import.meta.url,
    "AutoResearch",
    "LiteratureReview",
  );
  assert.equal(graph.flow.nodes.length, 15);
  assert.equal(graph.flow.nodes.filter((node) => node.kind === "input").length, 1);
  assert.equal(graph.flow.nodes.filter((node) => node.id.startsWith("__")).length, 2);
  assert.equal(graph.flow.nodes.filter((node) => node.kind === "step").length, 13);
  assert.deepEqual(
    graph.flow.edges
      .filter((edge) => edge.to === "prepareCollection")
      .map((edge) => edge.field)
      .sort(),
    ["audience", "decisionContext", "keywordPlanRef", "question"],
  );
  assert.doesNotMatch(
    graph.flow.edges.map((edge) => `${edge.from}->${edge.to}`).join("\n"),
    /reviseReport->reviewReport/u,
  );
  assert.deepEqual(
    graph.flow.nodes.map((node) => node.call).filter(Boolean),
    [
      "literature.codex",
      "literature.collection",
      "literature.collection",
      "literature.collection",
      "literature.analysis",
      "literature.analysis",
      "literature.analysis",
      "literature.report",
      "literature.report",
      "literature.report",
      "literature.report",
      "literature.report",
      "literature.report",
    ],
  );
});
function packSource(version: string, body: string): string {
  return `domain SamplePack version "${version}"
title "Sample Pack"
${body}
`;
}

async function withDataRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-domain-packs-"));
  const previous = process.env.POLARIS_DATA_ROOT;
  process.env.POLARIS_DATA_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("pack add, list, and remove persist a verified DSL installation outside Vaults", { concurrency: false }, async () => {
  await withDataRoot(async (dataRoot) => {
    const sourcePath = path.join(dataRoot, "sample.ord");
    fs.writeFileSync(sourcePath, packSource("1.0.0", `
port ReadValue version "1.0.0" {
  in { key: String }
  out { value: String }
  effect read
}

flow Read title "Read value" create {
  input { key: String required }
  needs { ReadValue }
  steps {
    read "Read" { uses { key } call ReadValue output { value: String } }
  }
  output { value: String from value }
  ui { layout form primary "Run" }
}
`), "utf8");

    await runCli(["pack", "add", sourcePath]);

    const installedRoot = path.join(
      dataRoot,
      "control",
      "domain-packs",
      "SamplePack",
      "1.0.0",
    );
    assert.equal(fs.statSync(installedRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(installedRoot, "main.ord")).mode & 0o777, 0o600);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(installedRoot, "manifest.json"), "utf8"),
    ) as { id: string; version: string; source: string; sha256: string };
    assert.deepEqual(
      { id: manifest.id, version: manifest.version, source: manifest.source },
      { id: "SamplePack", version: "1.0.0", source: "main.ord" },
    );
    assert.match(manifest.sha256, /^[a-f0-9]{64}$/u);

    await runCli(["pack", "list"]);
    fs.appendFileSync(path.join(installedRoot, "main.ord"), "\n", "utf8");
    const drifted = listDomainPacks(import.meta.url)
      .find((pack) => pack.id === "SamplePack");
    assert.equal(drifted?.status, "drifted");

    await runCli(["pack", "remove", "SamplePack", "--version", "1.0.0"]);
    assert.equal(fs.existsSync(installedRoot), false);
  });
});

test("pack remove requires a version when multiple versions are installed", { concurrency: false }, async () => {
  await withDataRoot(async (dataRoot) => {
    for (const version of ["1.0.0", "2.0.0"]) {
      const sourcePath = path.join(dataRoot, `sample-${version}.ord`);
      fs.writeFileSync(sourcePath, packSource(version, `
port ReadValue version "1.0.0" {
  in { key: String }
  out { value: String }
  effect read
}
`), "utf8");
      await runCli(["pack", "add", sourcePath]);
    }

    await assert.rejects(
      () => runCli(["pack", "remove", "SamplePack"]),
      /multiple installed versions/u,
    );
    await runCli(["pack", "remove", "SamplePack", "--version", "1.0.0"]);
    assert.equal(
      fs.existsSync(path.join(dataRoot, "control", "domain-packs", "SamplePack", "2.0.0")),
      true,
    );
  });
});

test("pack add resolves imports from already installed packs", { concurrency: false }, async () => {
  await withDataRoot(async (dataRoot) => {
    const dependencyPath = path.join(dataRoot, "dependency.ord");
    fs.writeFileSync(dependencyPath, `domain SharedCapabilities version "1.0.0"
port ReadValue version "1.0.0" {
  in { key: String }
  out { value: String }
  effect read
}
`, "utf8");
    await runCli(["pack", "add", dependencyPath]);
    const newerDependencyPath = path.join(dataRoot, "dependency-v2.ord");
    fs.writeFileSync(newerDependencyPath, `domain SharedCapabilities version "2.0.0"
port ReadValue version "1.0.0" {
  in { key: String }
  out { value: String }
  effect read
}
`, "utf8");
    await runCli(["pack", "add", newerDependencyPath]);

    const appPath = path.join(dataRoot, "app.ord");
    fs.writeFileSync(appPath, `domain SamplePack version "1.0.0"
import SharedCapabilities version "1.0.0"
flow Read title "Read value" create {
  input { key: String required }
  needs { ReadValue }
  steps {
    read "Read" { uses { key } call ReadValue output { value: String } }
  }
  output { value: String from value }
  ui { layout form primary "Run" }
}
`, "utf8");
    await runCli(["pack", "add", appPath]);
    assert.equal(
      fs.existsSync(path.join(dataRoot, "control", "domain-packs", "SamplePack", "1.0.0")),
      true,
    );
  });
});

test("pack projection exposes flow metadata for the Portal catalog", { concurrency: false }, async () => {
  await withDataRoot(async (dataRoot) => {
    const sourcePath = path.join(dataRoot, "portal-pack.ord");
    fs.writeFileSync(sourcePath, packSource("1.0.0", `
port ReadValue version "1.0.0" {
  in { brief: String }
  out { result: String }
  effect read
}

port ConfirmResult version "1.0.0" {
  builtin manual.review
  in { result: String }
  out { approved: Boolean }
  effect human
}

flow Review title "Review evidence" create {
  description "Review a bounded evidence brief."
  input { brief: String required control textarea label "Evidence brief" placeholder "Synthetic input" }
  needs { ReadValue, ConfirmResult }
  steps {
    read "Read evidence" { uses { brief } call ReadValue output { result: String } }
    confirm "Confirm result" { uses { result } call ConfirmResult output { approved: Boolean } }
  }
  output { approved: Boolean from approved }
  ui { layout form primary "Review" }
}
`), "utf8");

    await runCli(["pack", "add", sourcePath]);

    const projections = listDomainPackProjections(import.meta.url);
    const projection = projections.find((pack) => pack.id === "SamplePack");
    assert.ok(projection);
    assert.equal(projection.flows[0]?.id, "Review");
    assert.equal(projection.flows[0]?.fields[0]?.required, true);
    assert.equal(projection.flows[0]?.fields[0]?.type, "textarea");
    assert.equal(projection.flows[0]?.approvalRequired, true);
    assert.deepEqual(
      projection.flows[0]?.toolCalls.map((call) => ({
        id: call.id,
        port: call.port,
        effect: call.effect,
        builtin: call.builtin,
        unresolved: call.unresolved,
      })),
      [
        {
          id: "read",
          port: "ReadValue",
          effect: "read",
          builtin: undefined,
          unresolved: false,
        },
        {
          id: "confirm",
          port: "ConfirmResult",
          effect: "human",
          builtin: "manual.review",
          unresolved: false,
        },
      ],
    );
    assert.match(projection.digest, /^sha256:[a-f0-9]{64}$/u);
  });
});

test("pack projection preserves role modules for separated workflow catalogs", { concurrency: false }, async () => {
  await withDataRoot(async (dataRoot) => {
    const sourcePath = path.join(dataRoot, "role-pack.ord");
    fs.writeFileSync(sourcePath, packSource("1.0.0", `
category "Synthetic"
accent "blue"
port ReadValue version "1.0.0" {
  in { value: String }
  out { result: String }
  effect read
}

module Teacher title "Teacher workflows" code "teacher" {
  flow Review title "Review" create {
    input { value: String required }
    needs { ReadValue }
    steps {
      review "Review" { uses { value } call ReadValue output { result: String } }
    }
    output { result: String from result }
    ui { layout form primary "Review" }
  }
}

module Student title "Student workflows" code "student" {
  flow Run title "Run" create {
    input { value: String required }
    needs { ReadValue }
    steps {
      run "Run" { uses { value } call ReadValue output { result: String } }
    }
    output { result: String from result }
    ui { layout form primary "Run" }
  }
}
`), "utf8");

    await runCli(["pack", "add", sourcePath]);

    const projection = listDomainPackProjections(import.meta.url)
      .find((pack) => pack.id === "SamplePack");
    assert.ok(projection);
    assert.equal(projection.category, "Synthetic");
    assert.equal(projection.accent, "blue");
    const teacher = projection.flows.find((flow) => flow.id === "Review");
    const student = projection.flows.find((flow) => flow.id === "Run");
    assert.deepEqual(
      { groupId: teacher?.groupId, groupTitle: teacher?.groupTitle },
      { groupId: "teacher", groupTitle: "Teacher workflows" },
    );
    assert.deepEqual(
      { groupId: student?.groupId, groupTitle: student?.groupTitle },
      { groupId: "student", groupTitle: "Student workflows" },
    );
  });
});

test("first-party Vault Knowledge Health pack projects the ArtifactMetadata read call", { concurrency: false }, async () => {
  await withDataRoot(async () => {
    await runCli(["pack", "add", FIRST_PARTY_VAULT_KNOWLEDGE_PACK]);

    const projections = listDomainPackProjections(import.meta.url);
    const pack = projections.find((candidate) => candidate.id === "VaultKnowledgeHealth");
    assert.ok(pack);
    assert.equal(pack.title, "Vault Knowledge Health");
    assert.equal(pack.category, "Vault Operations");
    assert.equal(pack.flows.length, 1);
    assert.deepEqual(pack.capabilities, ["Artifact Metadata"]);

    const flow = pack.flows[0];
    assert.equal(flow?.id, "ReviewKnowledgeHealth");
    assert.equal(flow?.approvalRequired, false);
    assert.deepEqual(flow?.fields, [{
      id: "artifactScope",
      label: "Artifact scope",
      type: "text",
      placeholder: "latest",
      required: false,
    }]);
    assert.deepEqual(flow?.toolCalls, [{
      id: "metadata",
      port: "ArtifactMetadata",
      version: "1.0.0",
      effect: "read",
      unresolved: false,
    }]);
  });
});

test("pack projection omits legacy trial metadata from the Portal catalog", { concurrency: false }, async () => {
  await withDataRoot(async (dataRoot) => {
    const sourcePath = path.join(dataRoot, "trial-pack.ord");
    fs.writeFileSync(sourcePath, `dsl version "0.4-trial"
domain TrialPack version "1.0.0"
title "Synthetic trial pack"
port Work version "1.0.0" {
  in {
    token: String
  }
  out {
    result: String
  }
  effect ffi
}
trial Main title "Synthetic trial" {
  input {
    token: String required
  }
  budget {
    timeout 10s
    cost 1
    maxTransitions 4
  }
  execution {
    class ai
    isolation disposable
    network deny
  }
  start work
  terminal { work }
  nodes {
    work "Work" {
      uses { token }
      call Work
      output { result: String }
      retry { max 1 }
    }
  }
}
`, "utf8");

    await runCli(["pack", "add", sourcePath]);

    const projection = listDomainPackProjections(import.meta.url)
      .find((pack) => pack.id === "TrialPack");
    assert.ok(projection);
    assert.deepEqual(projection.flows, []);
  });
});

test("built-in AutoResearch pack exposes one v0.3 flow", { concurrency: false }, async () => {
  await withDataRoot(async () => {
    const projection = listDomainPackProjections(import.meta.url)
      .find((candidate) => candidate.id === "AutoResearch");
    assert.ok(projection);
    assert.equal(projection.title, "autoresearch");
    assert.equal(projection.languageVersion, "0.3");
    assert.deepEqual(
      projection.flows.map((flow) => ({
        id: flow.id,
        title: flow.title,
        estimate: flow.estimate,
      })),
      [{
        id: "LiteratureReview",
        title: "Literature Review",
        estimate: "13 个阶段",
      }],
    );
    assert.equal(projection.flows.length, 1);
  });
});

test("third-party domain pack sources remain discoverable without installing them", { concurrency: false }, async () => {
  await withDataRoot(async () => {
    const summaries = listDomainPacks(import.meta.url);
    const sourceIds = ["AfaDtc", "CourseworkVaults", "SysSecResearch"]
      .filter((id) => summaries.some((pack) => pack.id === id));
    assert.ok(sourceIds.length > 0);
    assert.ok(sourceIds.every((id) => summaries.some((pack) => pack.id === id)));
  });
});

test("third-party packs remain visible in the workflow catalog even without local tools", { concurrency: false }, async () => {
  await withDataRoot(async () => {
    const projections = listDomainPackProjections(import.meta.url);
    const thirdPartyIds = ["AfaDtc", "CourseworkVaults", "SysSecResearch"];
    const visibleIds = projections.map((pack) => pack.id);
    assert.ok(thirdPartyIds.some((id) => visibleIds.includes(id)));
    const extensible = projections.find((pack) => thirdPartyIds.includes(pack.id));
    assert.ok(extensible);
    assert.ok((extensible.warnings?.length ?? 0) > 0);
  });
});

test("pack add rejects invalid DSL without creating a partial installation", { concurrency: false }, async () => {
  await withDataRoot(async (dataRoot) => {
    const sourcePath = path.join(dataRoot, "invalid.ord");
    fs.writeFileSync(sourcePath, "domain Broken version \"1.0.0\"\n", "utf8");
    await assert.rejects(
      () => runCli(["pack", "add", sourcePath]),
      /Domain Pack validation failed/u,
    );
    assert.equal(
      fs.existsSync(path.join(dataRoot, "control", "domain-packs")),
      false,
    );
  });
});
