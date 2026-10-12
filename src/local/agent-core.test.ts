import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bundleCore, CORE_OUT } from "../../scripts/build-agent-core.mjs";

describe("the agent's bundle of CloudLab's service code", () => {
  it("is up to date with src/ (run `npm run agent:core` if this fails)", async () => {
    expect(readFileSync(CORE_OUT, "utf8") === (await bundleCore())).toBe(true);
  }, 30_000);
});
