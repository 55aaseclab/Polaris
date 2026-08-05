import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function withStorageFixture({
  dockerRoot = "/var/lib/polaris-docker",
  mountInfo = "xfs rw,relatime,pquota",
}, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-docker-storage-root-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  writeExecutable(path.join(bin, "docker"), `#!/usr/bin/env bash
if [ "$1" = "info" ] && [ "$2" = "--format" ]; then
  case "$3" in
    *DockerRootDir*) printf '%s\\n' '${dockerRoot}' ;;
    *) printf '%s\\n' 'overlay2' ;;
  esac
  exit 0
fi
exit 1
`);
  writeExecutable(path.join(bin, "findmnt"), `#!/usr/bin/env bash
printf '%s\\n' '${mountInfo}'
`);
  try {
    run({ bin });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runVerify(bin, mountPath) {
  return spawnSync("bash", [
    "scripts/provision-docker-storage-root.sh",
    "--verify",
    "--mount-path",
    mountPath,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

test("Docker storage verification accepts overlay2 on XFS project quotas", () => {
  const mountPath = "/var/lib/polaris-docker";
  withStorageFixture({}, ({ bin }) => {
    const result = runVerify(bin, mountPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /docker storage root: verified/);
  });
});

test("Docker storage verification rejects non-XFS Docker roots", () => {
  const mountPath = "/var/lib/polaris-docker";
  withStorageFixture({ mountInfo: "ext4 rw,relatime" }, ({ bin }) => {
    const result = runVerify(bin, mountPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Docker must use overlay2 on xfs with pquota or prjquota/);
  });
});

test("Docker storage verification rejects a mismatched configured mount", () => {
  withStorageFixture({}, ({ bin }) => {
    const result = runVerify(bin, "/srv/polaris/docker-root");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match configured mount/);
  });
});

test("Docker storage provisioning requires an explicit operation mode", () => {
  const result = spawnSync("bash", ["scripts/provision-docker-storage-root.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});
