import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../scripts/cli/main.js";
import {
  listDomainPackProjections,
  listDomainPacks,
} from "../scripts/config/domain-packs.js";

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
    const drifted = listDomainPacks(import.meta.url);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.status, "drifted");

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
    assert.equal(projections.length, 1);
    assert.equal(projections[0]?.flows[0]?.id, "Review");
    assert.equal(projections[0]?.flows[0]?.fields[0]?.required, true);
    assert.equal(projections[0]?.flows[0]?.fields[0]?.type, "textarea");
    assert.equal(projections[0]?.flows[0]?.approvalRequired, true);
    assert.deepEqual(
      projections[0]?.flows[0]?.toolCalls.map((call) => ({
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
    assert.match(projections[0]?.digest ?? "", /^sha256:[a-f0-9]{64}$/u);
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

    const projection = listDomainPackProjections(import.meta.url)[0];
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
