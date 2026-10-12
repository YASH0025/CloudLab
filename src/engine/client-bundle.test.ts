import { execSync } from "node:child_process";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { serviceCatalog, resolveServices } from "./registry";

/**
 * The console runs in the browser; the engine (services, CLI, Lambda runtime,
 * CloudFormation…) runs on the server. Browser code gets the service catalogue
 * as data. These checks keep it that way, so adding services or whole cloud
 * providers doesn't make every page heavier.
 */

const SERVER_ONLY = ["src/engine/registry.ts", "src/engine/engine.ts", "src/cli/commands.ts", "src/engine/lambda/", "src/engine/cloudformation/", "node_modules/quickjs", "node_modules/yaml/"];

describe("what the browser downloads", () => {
  it("keeps the engine, the CLI and their libraries out of browser code", async () => {
    const entries = execSync(`grep -rl --include=*.tsx --include=*.ts --exclude=*.test.ts '^"use client"' src`).toString().trim().split("\n");
    const r = await build({
      entryPoints: entries,
      bundle: true,
      write: false,
      metafile: true,
      outdir: "/tmp/cl-client-check",
      format: "esm",
      platform: "browser",
      splitting: true,
      logLevel: "silent",
      // Only CloudLab's own code is followed; npm packages show up as external imports.
      packages: "external",
      loader: { ".css": "empty" },
      tsconfig: "tsconfig.json",
    });
    const files = Object.keys(r.metafile.inputs);
    const packages = Object.values(r.metafile.inputs).flatMap((i) => i.imports.filter((x) => x.external).map((x) => `node_modules/${x.path}/`));
    const inputs = [...files, ...packages];
    const leaked = inputs.filter((p) => SERVER_ONLY.some((s) => p.includes(s)));
    expect(leaked).toEqual([]);
  }, 60_000);

  it("sends the service catalogue as plain data", () => {
    const catalog = serviceCatalog();
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
    expect(catalog.length).toBeGreaterThan(10);
    // Regions fill in their own options (availability zones…) from the same data.
    const subnet = resolveServices("us-east-1").find((s) => s.id === "networking")!.types.find((t) => t.type === "subnet")!;
    expect(subnet.fields.find((f) => f.key === "availabilityZone")?.options?.[0]).toMatchObject({ value: "us-east-1a" });
  });
});
