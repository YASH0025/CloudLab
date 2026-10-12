import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { LocalS3 } from "../../public/agent/cloudlab-agent.mjs";

const make = () => {
  const d = mkdtempSync(path.join(tmpdir(), "cl-s3-"));
  const s3 = new LocalS3(path.join(d, "s3"), path.join(d, "meta.json"));
  s3.createBucket({ name: "photos", versioning: "Disabled", blockPublicAccess: true, publicRead: false, websiteEnabled: false, indexDocument: null, errorDocument: null });
  return { s3, root: path.join(d, "s3", "photos") };
};
const body = (text: string) => Readable.from([Buffer.from(text)]);

describe("the agent's own S3", () => {
  it("keeps objects as real files, with folders for slashes", async () => {
    const { s3, root } = make();
    const o = await s3.put("photos", "2026/cat.txt", body("meow"), "text/plain");
    expect(o).toMatchObject({ key: "2026/cat.txt", size: 4, etag: expect.stringMatching(/^[0-9a-f]{32}$/), contentType: "text/plain" });
    expect(readFileSync(path.join(root, "2026", "cat.txt"), "utf8")).toBe("meow");
    expect(s3.list("photos", "", "/")).toEqual({ objects: [], prefixes: ["2026/"] });
    expect(s3.list("photos", "2026/", "/").objects.map((x: { key: string }) => x.key)).toEqual(["2026/cat.txt"]);
    expect(s3.stats("photos")).toEqual({ objectCount: 1, totalBytes: 4 });
  });

  it("sees files added by hand, and forgets folders once they're empty", async () => {
    const { s3, root } = make();
    writeFileSync(path.join(root, "manual.md"), "# hi");
    const [o] = s3.list("photos", "", "/").objects;
    expect(o).toMatchObject({ key: "manual.md", size: 4, contentType: "text/markdown" });
    await s3.put("photos", "a/b/c.txt", body("x"));
    s3.delete("photos", "a/b/c.txt");
    expect(existsSync(path.join(root, "a"))).toBe(false);
  });

  it("makes folders like the console does: an object whose key ends in /", async () => {
    const { s3, root } = make();
    await s3.put("photos", "albums/", body(""));
    expect(existsSync(path.join(root, "albums"))).toBe(true);
    expect(s3.list("photos", "", "/").prefixes).toEqual(["albums/"]);
    await s3.put("photos", "albums/one.jpg", body("img"));
    s3.delete("photos", "albums/one.jpg");
    expect(s3.list("photos", "", "/").prefixes).toEqual(["albums/"]);
    expect(s3.deletePrefix("photos", "albums/")).toEqual(["albums/"]);
    expect(s3.list("photos", "", "/").prefixes).toEqual([]);
  });

  it("refuses keys that would leave the bucket's folder, and missing things with S3's errors", async () => {
    const { s3 } = make();
    for (const key of ["../escape.txt", "a/../../b", "/abs", "a\\b"]) await expect(s3.put("photos", key, body("x"))).rejects.toMatchObject({ code: "InvalidArgument" });
    expect(() => s3.info("photos", "nope.txt")).toThrow(expect.objectContaining({ code: "NoSuchKey" }));
    expect(() => s3.list("nobucket")).toThrow(expect.objectContaining({ code: "NoSuchBucket" }));
  });

  it("serves a static website with S3's rules", async () => {
    const { s3 } = make();
    await s3.put("photos", "index.html", body("<h1>home</h1>"), "text/html");
    await s3.put("photos", "docs/index.html", body("<h1>docs</h1>"), "text/html");
    expect(s3.website("photos", "/")).toMatchObject({ status: 404 });
    s3.configureBucket({ name: "photos", websiteEnabled: true, indexDocument: "index.html" });
    expect(s3.website("photos", "/")).toMatchObject({ status: 403 });
    s3.configureBucket({ name: "photos", blockPublicAccess: false, publicRead: true });
    expect(s3.website("photos", "/").body.toString()).toBe("<h1>home</h1>");
    expect(s3.website("photos", "/docs")).toMatchObject({ status: 302, location: "/docs/" });
    expect(s3.website("photos", "/docs/").body.toString()).toBe("<h1>docs</h1>");
    expect(s3.website("photos", "/missing").status).toBe(404);
  });

  it("keeps a bucket's folder when files were added outside CloudLab", async () => {
    const { s3, root } = make();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "keep.txt"), "mine");
    expect(s3.deleteBucket("photos")).toBe(true);
    expect(existsSync(path.join(root, "keep.txt"))).toBe(true);
  });
});
