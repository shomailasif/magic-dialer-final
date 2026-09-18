/**
 * Bundle the customer PC agent into a single self-contained JS file.
 * Free (uses esbuild, already in the project). This is the file that gets
 * turned into the Windows .exe with pkg, then wrapped into the installer.
 *
 * Run: node build/bundle.js
 * Output: build/dist/agent-bundle.js
 */
const esbuild = require("esbuild");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

esbuild
  .build({
    entryPoints: [path.join(root, "agent", "agent.js")],
    bundle: true,
    platform: "node",
    target: ["node18"],
    format: "cjs",
    loader: { ".node": "copy" },
    assetNames: "native/[name]-[hash]",
    outfile: path.join(__dirname, "dist", "agent-bundle.js"),
    banner: { js: "#!/usr/bin/env node" },
  })
  .then(() => console.log("Bundled agent -> build/dist/agent-bundle.js"))
  .catch((e) => {
    console.error("Bundle failed:", e.message);
    process.exit(1);
  });
