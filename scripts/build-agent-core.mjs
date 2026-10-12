// Bundles the service code the agent shares with CloudLab (src/local/agent-core.ts)
// into public/agent/lib/core.mjs. Run after changing that code: npm run agent:core
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CORE_OUT = fileURLToPath(new URL("../public/agent/lib/core.mjs", import.meta.url));
const HEADER = "// Generated from src/local/agent-core.ts by `npm run agent:core`. Don't edit by hand.\n";

export async function bundleCore() {
  const r = await build({
    entryPoints: [fileURLToPath(new URL("../src/local/agent-core.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    legalComments: "none",
    logLevel: "silent",
    tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
  });
  return HEADER + r.outputFiles[0].text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = await bundleCore();
  writeFileSync(CORE_OUT, code);
  console.log(`Wrote ${CORE_OUT} (${(code.length / 1024).toFixed(0)} KB)`);
}
