import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("remote deploy restarts Polaris through a host systemd service", () => {
  const script = fs.readFileSync("scripts/deploy-polaris.sh", "utf8");
  assert.match(script, /systemctl enable "polaris-server@\$\{target_color\}\.service"/);
  assert.match(script, /systemctl restart "polaris-server@\$\{target_color\}\.service"/);
  assert.doesNotMatch(script, /POLARIS_SERVER_UID/);
  assert.doesNotMatch(script, /POLARIS_SERVER_GID/);
});

test("remote provision installs a host Polaris systemd unit", () => {
  const script = fs.readFileSync("scripts/provision-remote.sh", "utf8");
  assert.match(script, /polaris-server@\.service/);
  assert.match(script, /EnvironmentFile=-.*polaris-server-%i\.env/);
  assert.match(script, /ExecStart=\/bin\/bash .*scripts\/run-polaris-server-host\.sh/);
});

test("bluegreen compose keeps only the web stack in Docker", () => {
  const compose = fs.readFileSync("deploy/docker-compose.polaris-bluegreen.yml", "utf8");
  assert.match(compose, /^\s*paseo-app:/m);
  assert.match(compose, /^\s*nginx:/m);
  assert.doesNotMatch(compose, /^\s*polaris-server:/m);
  assert.doesNotMatch(compose, /apps\/polaris\/Dockerfile/);
});

test("host Polaris launcher reads bind host and port from the environment", () => {
  const script = fs.readFileSync("scripts/run-polaris-server-host.sh", "utf8");
  assert.match(script, /POLARIS_SERVER_PORT/);
  assert.match(script, /POLARIS_SERVER_BIND_HOST/);
  assert.match(script, /apps\/polaris\/dist\/scripts\/polaris\.js/);
});
