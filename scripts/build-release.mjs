import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveCurrentReleaseVersion } from "./release-version.mjs";

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    ...options,
  });
}

function parseArgs(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    flags.set(token.slice(2), argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : "true");
  }
  return flags;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function hasCommand(command) {
  const result = spawnSync("bash", ["-lc", `command -v "${command}"`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function requireCommand(command, reason) {
  if (!hasCommand(command)) {
    throw new Error(`${command} is required to ${reason}`);
  }
}

function copyDir(source, target) {
  ensureDir(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
      continue;
    }
    fs.copyFileSync(from, to);
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildReleaseManifest(version, imagePrefix) {
  return {
    version,
    releaseChannel: process.env.POLARIS_RELEASE_CHANNEL?.trim() || "stable",
    images: {
      controlPlane: `${imagePrefix}/polaris-control-plane:${version}`,
      paseoApp: `${imagePrefix}/paseo-app:${version}`,
    },
  };
}

function pkgTargetFor(platform) {
  if (platform === "linux-x64") {
    return "node18-linux-x64";
  }
  if (platform === "win-x64") {
    return "node18-win-x64";
  }
  if (platform === "macos-x64") {
    return "node18-macos-x64";
  }
  if (platform === "macos-arm64") {
    return "node18-macos-arm64";
  }
  throw new Error(`Unsupported package platform '${platform}'`);
}

function buildBinaries(distRoot, platform) {
  const target = pkgTargetFor(platform);
  const outputDir = path.join(distRoot, platform, "bin");
  const bundleDir = path.join(distRoot, platform, "pkg-entry");
  ensureDir(outputDir);
  ensureDir(bundleDir);
  const cliBundle = path.join(bundleDir, "polaris-cli.cjs");
  const desktopBundle = path.join(bundleDir, "polaris-desktop.cjs");
  run("pnpm", [
    "dlx",
    "esbuild",
    "apps/polaris/dist/scripts/packaged-local-deploy-cli.js",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${cliBundle}`,
  ]);
  run("pnpm", [
    "dlx",
    "esbuild",
    "apps/polaris/dist/scripts/packaged-local-deploy-desktop.js",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${desktopBundle}`,
  ]);
  run("pnpm", [
    "dlx",
    "pkg",
    cliBundle,
    "--targets",
    target,
    "--output",
    path.join(outputDir, platform.startsWith("win-") ? "polaris.exe" : "polaris"),
  ]);
  run("pnpm", [
    "dlx",
    "pkg",
    desktopBundle,
    "--targets",
    target,
    "--output",
    path.join(outputDir, platform.startsWith("win-") ? "polaris-desktop.exe" : "polaris-desktop"),
  ]);
  return outputDir;
}

function stageBundle(distRoot, platform, releaseManifest) {
  const bundleRoot = path.join(distRoot, platform, "bundle");
  copyDir(path.join("deploy", "local-deploy"), bundleRoot);
  writeJson(path.join(bundleRoot, "release.json"), releaseManifest);
  return bundleRoot;
}

function writeMacosInfoPlist(filePath, version) {
  fs.writeFileSync(
    filePath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Polaris</string>
  <key>CFBundleExecutable</key>
  <string>polaris-desktop</string>
  <key>CFBundleIdentifier</key>
  <string>com.polaris.desktop</string>
  <key>CFBundleName</key>
  <string>Polaris</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
</dict>
</plist>
`,
    "utf8",
  );
}

function buildMacosBundle(distRoot, platform, version) {
  if (process.platform !== "darwin") {
    throw new Error("macOS release packaging must run on a macOS host");
  }
  requireCommand("hdiutil", "build the macOS dmg");
  const platformRoot = path.join(distRoot, platform);
  const appRoot = path.join(platformRoot, "Polaris.app");
  const contentsRoot = path.join(appRoot, "Contents");
  const macosRoot = path.join(contentsRoot, "MacOS");
  ensureDir(macosRoot);
  ensureDir(path.join(contentsRoot, "Resources"));
  fs.copyFileSync(
    path.join(platformRoot, "bin", "polaris-desktop"),
    path.join(macosRoot, "polaris-desktop"),
  );
  fs.copyFileSync(
    path.join(platformRoot, "bin", "polaris"),
    path.join(macosRoot, "polaris"),
  );
  fs.chmodSync(path.join(macosRoot, "polaris-desktop"), 0o755);
  fs.chmodSync(path.join(macosRoot, "polaris"), 0o755);
  copyDir(path.join(platformRoot, "bundle"), path.join(macosRoot, "bundle"));
  writeMacosInfoPlist(path.join(contentsRoot, "Info.plist"), version);
  const releaseRoot = path.join(platformRoot, "release-package");
  fs.rmSync(releaseRoot, { recursive: true, force: true });
  ensureDir(releaseRoot);
  copyDir(appRoot, path.join(releaseRoot, "Polaris.app"));
  fs.copyFileSync(
    path.join(platformRoot, "bin", "polaris"),
    path.join(releaseRoot, "polaris"),
  );
  fs.chmodSync(path.join(releaseRoot, "polaris"), 0o755);
  const applicationsLink = path.join(releaseRoot, "Applications");
  fs.rmSync(applicationsLink, { force: true });
  fs.symlinkSync("/Applications", applicationsLink);
  const dmgName = `polaris_${version}_${platform.replace("-", "_")}.dmg`;
  const dmgPath = path.join(distRoot, dmgName);
  fs.rmSync(dmgPath, { force: true });
  run("hdiutil", [
    "create",
    "-volname",
    "Polaris",
    "-srcfolder",
    releaseRoot,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]);
}

function buildWindowsBundle(distRoot, version) {
  requireCommand("makensis", "build the Windows installer");
  const platformRoot = path.join(distRoot, "win-x64");
  const releaseRoot = path.join(platformRoot, "release-package");
  fs.rmSync(releaseRoot, { recursive: true, force: true });
  ensureDir(releaseRoot);
  copyDir(path.join(platformRoot, "bin"), path.join(releaseRoot, "bin"));
  copyDir(path.join(platformRoot, "bundle"), path.join(releaseRoot, "bundle"));
  fs.copyFileSync(
    path.join(platformRoot, "README.txt"),
    path.join(releaseRoot, "README.txt"),
  );
  const scriptPath = path.join(platformRoot, "installer.nsi");
  const outputPath = path.join(distRoot, `polaris_${version}_win_x64_setup.exe`);
  fs.writeFileSync(
    scriptPath,
    [
      "Unicode true",
      "ManifestDPIAware true",
      "RequestExecutionLevel user",
      `OutFile "${outputPath}"`,
      'InstallDir "$LOCALAPPDATA\\Programs\\Polaris"',
      "Page directory",
      "Page instfiles",
      "UninstPage uninstConfirm",
      "UninstPage instfiles",
      "",
      'Section "Install"',
      '  SetOutPath "$INSTDIR"',
      `  File /r "${path.join(releaseRoot, "bin")}"`,
      `  File /r "${path.join(releaseRoot, "bundle")}"`,
      `  File "${path.join(releaseRoot, "README.txt")}"`,
      '  CreateDirectory "$SMPROGRAMS\\Polaris"',
      '  CreateShortcut "$SMPROGRAMS\\Polaris\\Polaris.lnk" "$INSTDIR\\bin\\polaris-desktop.exe"',
      '  CreateShortcut "$DESKTOP\\Polaris.lnk" "$INSTDIR\\bin\\polaris-desktop.exe"',
      '  WriteUninstaller "$INSTDIR\\Uninstall Polaris.exe"',
      'SectionEnd',
      "",
      'Section "Uninstall"',
      '  Delete "$DESKTOP\\Polaris.lnk"',
      '  Delete "$SMPROGRAMS\\Polaris\\Polaris.lnk"',
      '  RMDir "$SMPROGRAMS\\Polaris"',
      '  Delete "$INSTDIR\\README.txt"',
      '  Delete "$INSTDIR\\Uninstall Polaris.exe"',
      '  RMDir /r "$INSTDIR\\bin"',
      '  RMDir /r "$INSTDIR\\bundle"',
      '  RMDir "$INSTDIR"',
      'SectionEnd',
      "",
    ].join("\n"),
    "utf8",
  );
  fs.rmSync(outputPath, { force: true });
  run("makensis", [scriptPath]);
}

function buildDebPackage(distRoot, version) {
  const stageRoot = path.join(distRoot, "linux-x64", "deb-stage");
  fs.rmSync(stageRoot, { recursive: true, force: true });
  const packageRoot = path.join(stageRoot, "polaris");
  const optRoot = path.join(packageRoot, "opt", "polaris");
  const binRoot = path.join(optRoot, "bin");
  const bundleRoot = path.join(optRoot, "bundle");
  const debianRoot = path.join(packageRoot, "DEBIAN");
  ensureDir(binRoot);
  ensureDir(bundleRoot);
  ensureDir(debianRoot);
  ensureDir(path.join(packageRoot, "usr", "bin"));
  ensureDir(path.join(packageRoot, "usr", "share", "applications"));
  copyDir(path.join(distRoot, "linux-x64", "bin"), binRoot);
  copyDir(path.join(distRoot, "linux-x64", "bundle"), bundleRoot);
  const cliPath = path.join(binRoot, "polaris");
  const desktopPath = path.join(binRoot, "polaris-desktop");
  fs.chmodSync(cliPath, 0o755);
  fs.chmodSync(desktopPath, 0o755);
  fs.symlinkSync("/opt/polaris/bin/polaris", path.join(packageRoot, "usr", "bin", "polaris"));
  fs.writeFileSync(
    path.join(packageRoot, "usr", "share", "applications", "polaris.desktop"),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Polaris",
      "Exec=/opt/polaris/bin/polaris-desktop",
      "Terminal=false",
      "Categories=Development;",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(debianRoot, "control"),
    [
      "Package: polaris",
      `Version: ${version}`,
      "Section: utils",
      "Priority: optional",
      "Architecture: amd64",
      "Maintainer: Polaris",
      "Depends: docker.io | docker-ce",
      "Description: Polaris desktop and CLI launchers",
      "",
    ].join("\n"),
    "utf8",
  );
  const debOutput = path.join(distRoot, `polaris_${version}_amd64.deb`);
  run("dpkg-deb", ["--build", "--root-owner-group", packageRoot, debOutput]);
}

function writeWindowsReadme(distRoot, version) {
  const readmePath = path.join(distRoot, "win-x64", "README.txt");
  fs.writeFileSync(
    readmePath,
    [
      `Polaris ${version}`,
      "",
      "Start the desktop app with bin\\polaris-desktop.exe",
      "Start the CLI with polaris.exe",
      "Keep the bundle/ directory next to the executables.",
      "",
    ].join("\n"),
    "utf8",
  );
}

const args = parseArgs(process.argv.slice(2));
const version = args.get("version") || resolveCurrentReleaseVersion();
const imagePrefix = args.get("image-prefix") || process.env.POLARIS_LOCAL_DEPLOY_IMAGE_PREFIX || "ghcr.io/example/polaris";
const outputDir = path.resolve(args.get("output-dir") || path.join("dist", "release"));
const platforms = (args.get("platforms") || "linux-x64,win-x64")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

ensureDir(outputDir);
run("pnpm", ["--filter", "polaris", "run", "build"]);

const releaseManifest = buildReleaseManifest(version, imagePrefix);
for (const platform of platforms) {
  buildBinaries(outputDir, platform);
  stageBundle(outputDir, platform, releaseManifest);
  if (platform === "macos-x64" || platform === "macos-arm64") {
    buildMacosBundle(outputDir, platform, version);
  }
  if (platform === "win-x64") {
    writeWindowsReadme(outputDir, version);
    buildWindowsBundle(outputDir, version);
  }
}
if (platforms.includes("linux-x64")) {
  buildDebPackage(outputDir, version);
}

const metadata = {
  version,
  imagePrefix,
  platforms,
  generatedAt: new Date().toISOString(),
  hostPlatform: os.platform(),
};
writeJson(path.join(outputDir, "release-metadata.json"), metadata);
