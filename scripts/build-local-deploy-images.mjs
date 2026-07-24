import { execFileSync } from "node:child_process";
import { resolveCurrentReleaseVersion } from "./release-version.mjs";

function run(command, args) {
  execFileSync(command, args, {
    stdio: "inherit",
  });
}

const version = process.env.VITE_POLARIS_APP_VERSION
  || process.env.POLARIS_APP_VERSION
  || resolveCurrentReleaseVersion();

run("docker", [
  "build",
  "-f",
  "apps/polaris/Dockerfile",
  "-t",
  `polaris-local/polaris-control-plane:${version}`,
  ".",
]);

run("docker", [
  "build",
  "-f",
  "apps/paseo/Dockerfile",
  "-t",
  `polaris-local/paseo-app:${version}`,
  ".",
]);
