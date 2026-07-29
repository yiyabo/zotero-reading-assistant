/**
 * Link builds/addon into the Zotero profile via a classic XUL/bootstrap
 * "proxy file", so rebuilds are picked up on the next Zotero restart
 * without reinstalling the XPI every time.
 *
 * What it does:
 *   1. Resolves the active Zotero profile (profiles.ini Default=1, or ZOTERO_PROFILE).
 *   2. Removes any previously installed .xpi of this addon.
 *   3. Writes extensions/<addonID> containing the absolute path to builds/addon.
 *
 * Usage:
 *   node scripts/link-dev.js
 *   npm run link-dev
 *   npm run restart   # build-dev → link-dev → stop → start
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const { config } = require("../package.json");
const addonID = config.addonID;
const addonDir = path.resolve(__dirname, "../builds/addon");

function profileRoot() {
  if (process.env.ZOTERO_PROFILE_DIR) {
    return process.env.ZOTERO_PROFILE_DIR;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/Zotero");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Zotero");
  }
  return path.join(os.homedir(), ".zotero/zotero");
}

function resolveProfileDir() {
  if (process.env.ZOTERO_PROFILE) {
    const root = profileRoot();
    const named = path.join(root, "Profiles", process.env.ZOTERO_PROFILE);
    if (fs.existsSync(named)) return named;
    if (fs.existsSync(process.env.ZOTERO_PROFILE)) return process.env.ZOTERO_PROFILE;
  }

  const root = profileRoot();
  const iniPath = path.join(root, "profiles.ini");
  if (!fs.existsSync(iniPath)) {
    throw new Error(`profiles.ini not found at ${iniPath}`);
  }

  const text = fs.readFileSync(iniPath, "utf8");
  const blocks = text.split(/\n(?=\[)/);
  let fallback = null;
  for (const block of blocks) {
    const pathMatch = block.match(/^Path=(.+)$/m);
    if (!pathMatch) continue;
    const isRelative = /IsRelative=1/.test(block);
    const dir = isRelative
      ? path.join(root, pathMatch[1].trim())
      : pathMatch[1].trim();
    if (/Default=1/.test(block)) return dir;
    if (!fallback) fallback = dir;
  }
  if (fallback) return fallback;
  throw new Error(`No profile found in ${iniPath}`);
}

function main() {
  if (!fs.existsSync(addonDir)) {
    console.error(`[link-dev] builds/addon missing. Run npm run build-dev first.`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(addonDir, "manifest.json"))) {
    console.error(`[link-dev] builds/addon/manifest.json missing — incomplete build.`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(addonDir, "bootstrap.js"))) {
    console.error(`[link-dev] builds/addon/bootstrap.js missing — incomplete build.`);
    process.exit(1);
  }

  const profileDir = resolveProfileDir();
  const extensionsDir = path.join(profileDir, "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });

  const proxyPath = path.join(extensionsDir, addonID);
  const xpiPath = path.join(extensionsDir, `${addonID}.xpi`);

  if (fs.existsSync(xpiPath)) {
    fs.unlinkSync(xpiPath);
    console.log(`[link-dev] removed installed XPI: ${xpiPath}`);
  }

  // Proxy file content = absolute path to unpacked addon directory.
  // Trailing slash is required by some Zotero/Firefox versions.
  const target = addonDir.endsWith(path.sep) ? addonDir : addonDir + path.sep;
  fs.writeFileSync(proxyPath, target, "utf8");
  console.log(`[link-dev] proxy → ${proxyPath}`);
  console.log(`[link-dev] points to ${target}`);
  console.log(`[link-dev] profile ${profileDir}`);
  console.log(`[link-dev] done. Restart Zotero to load. After that: npm run build-dev && npm run restart`);
}

main();
