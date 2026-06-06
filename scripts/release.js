const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function run(cmd) {
  console.log(`> ${cmd}`);
  return execSync(cmd, { stdio: "inherit" });
}

function runSilent(cmd) {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

async function main() {
  const args = process.argv.slice(2);
  const bumpType = args[0] || "patch";

  if (!["patch", "minor", "major"].includes(bumpType)) {
    console.error("Usage: node scripts/release.js [patch|minor|major]");
    process.exit(1);
  }

  console.log(`\n📦 Bumping version (${bumpType})...`);
  run(`npm version ${bumpType} --no-git-tag-version`);

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
  const version = pkg.version;
  console.log(`   New version: ${version}`);

  console.log("\n🔨 Building plugin...");
  run("npm run build-prod");

  const updateJson = JSON.parse(fs.readFileSync("builds/update.json", "utf-8"));
  const addonId = pkg.config.addonID;
  if (!updateJson.addons[addonId]) {
    console.error("❌ update.json missing addon entry");
    process.exit(1);
  }
  
  const updateEntry = updateJson.addons[addonId].updates[0];
  if (updateEntry.update_link.includes("__updateLink__")) {
    console.error("❌ update_link placeholder not replaced");
    process.exit(1);
  }
  
  console.log(`   ✅ update.json validated`);
  console.log(`   Version: ${updateEntry.version}`);
  console.log(`   Update link: ${updateEntry.update_link}`);

  const buildDir = "builds";
  fs.copyFileSync(path.join(buildDir, "update.json"), path.join(buildDir, "update.json.release"));

  console.log("\n📝 Creating git commit and tag...");
  run("git add package.json");
  run(`git commit -m "chore: release v${version}"`);
  run(`git tag v${version}`);

  console.log("\n🚀 Pushing to GitHub...");
  run("git push origin main");
  run(`git push origin v${version}`);

  console.log("\n📤 Creating GitHub release...");
  const releaseNotes = `## Zotero Reading Assistant v${version}

### Installation
1. Download \`zotero-reading-assistant.xpi\`
2. In Zotero: Tools → Add-ons → ⚙️ → Install Add-on From File
3. Select the downloaded XPI file

### Auto-update
Zotero will automatically check for updates from this release.`;

  run(
    `gh release create v${version} ` +
    `--title "v${version}" ` +
    `--notes "${releaseNotes.replace(/"/g, '\\"')}" ` +
    `builds/zotero-reading-assistant.xpi ` +
    `builds/update.json`
  );

  console.log(`\n✅ Released v${version} successfully!`);
  console.log(`   ${pkg.config.releasepage}/tag/v${version}`);
}

main().catch((err) => {
  console.error("\n❌ Release failed:", err.message);
  process.exit(1);
});
