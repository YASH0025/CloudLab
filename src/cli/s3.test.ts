import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";
import { localUploads } from "./uploads";

let engine: Engine;
const ACCOUNT = "acct-s3";
const files: Record<string, string> = {};
const run = (line: string) => executeCli(line, { engine, accountId: ACCOUNT, region: "us-east-1", files });
async function ok(line: string) {
  const r = await run(line);
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r;
}
const json = async (line: string) => JSON.parse((await ok(line)).output || "{}");
const file = (name: string, text: string) => {
  files[name] = Buffer.from(text).toString("base64");
};
const website = (bucket: string, path: string) => engine.objects.website(bucket, path);

beforeEach(() => {
  engine = new Engine(new MemoryStore());
  for (const k of Object.keys(files)) delete files[k];
});

describe("aws s3 with objects", () => {
  it("uploads, lists, downloads, copies and deletes like the real CLI", async () => {
    await ok("aws s3 mb s3://site-bucket-1");
    file("index.html", "<h1>Hello</h1>");
    file("logo.png", "PNGDATA");
    expect((await ok("aws s3 cp index.html s3://site-bucket-1/")).output).toBe("upload: index.html to s3://site-bucket-1/index.html");
    expect((await ok("aws s3 cp logo.png s3://site-bucket-1/images/logo.png")).output).toBe(
      "upload: logo.png to s3://site-bucket-1/images/logo.png",
    );

    const ls = (await ok("aws s3 ls s3://site-bucket-1")).output.split("\n");
    expect(ls[0]).toBe(`${" ".repeat(27)}PRE images/`);
    expect(ls[1]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d +14 index\.html$/);
    expect((await ok("aws s3 ls s3://site-bucket-1/images/")).output).toMatch(/ +7 logo\.png$/);
    const all = await ok("aws s3 ls s3://site-bucket-1 --recursive --summarize");
    expect(all.output).toContain("images/logo.png");
    expect(all.output).toContain("Total Objects: 2");

    const dl = await ok("aws s3 cp s3://site-bucket-1/index.html .");
    expect(dl.output).toBe("download: s3://site-bucket-1/index.html to ./index.html");
    expect(dl.download).toMatchObject({ filename: "index.html", contentType: "text/html" });
    expect(Buffer.from(dl.download!.data, "base64").toString()).toBe("<h1>Hello</h1>");
    expect((await ok("aws s3 cp s3://site-bucket-1/index.html -")).output).toBe("<h1>Hello</h1>");

    expect((await ok("aws s3 cp s3://site-bucket-1/index.html s3://site-bucket-1/backup/")).output).toBe(
      "copy: s3://site-bucket-1/index.html to s3://site-bucket-1/backup/index.html",
    );
    expect((await ok("aws s3 rm s3://site-bucket-1/backup/index.html")).output).toBe("delete: s3://site-bucket-1/backup/index.html");

    // A bucket with objects can't be removed until it's emptied.
    const rb = await run("aws s3 rb s3://site-bucket-1");
    expect(rb.exitCode).toBe(1);
    expect(rb.output).toBe(
      "remove_bucket failed: s3://site-bucket-1 An error occurred (BucketNotEmpty) when calling the DeleteBucket operation: The bucket you tried to delete is not empty",
    );
    expect((await ok("aws s3 rb s3://site-bucket-1 --force")).output.split("\n")).toEqual([
      "delete: s3://site-bucket-1/images/logo.png",
      "delete: s3://site-bucket-1/index.html",
      "remove_bucket: site-bucket-1",
    ]);
  });

  it("explains missing files and keys the way the CLI does", async () => {
    await ok("aws s3 mb s3://errs-bucket-1");
    const missing = await run("aws s3 cp notes.txt s3://errs-bucket-1/");
    expect(missing).toMatchObject({ exitCode: 255, output: "The user-provided path notes.txt does not exist." });
    const nokey = await run("aws s3 cp s3://errs-bucket-1/nope.txt .");
    expect(nokey.exitCode).toBe(1);
    expect(nokey.output).toContain("(NoSuchKey) when calling the GetObject operation: The specified key does not exist.");
    const nobucket = await run("aws s3 ls s3://no-such-bucket-xyz");
    expect(nobucket.exitCode).toBe(254);
    expect(nobucket.output).toContain("(NoSuchBucket) when calling the ListObjectsV2 operation: The specified bucket does not exist");
    expect((await run("aws s3api head-object --bucket errs-bucket-1 --key nope")).output).toContain(
      "An error occurred (404) when calling the HeadObject operation: Not Found",
    );
    file("big.bin", "x".repeat(1024 * 1024 + 1));
    expect((await run("aws s3 cp big.bin s3://errs-bucket-1/")).output).toContain("(EntityTooLarge)");
  });

  it("supports the s3api object commands", async () => {
    await ok("aws s3api create-bucket --bucket api-bucket-1");
    file("data.json", '{"a":1}');
    const put = await json("aws s3api put-object --bucket api-bucket-1 --key data/data.json --body data.json");
    expect(put.ETag).toMatch(/^"[0-9a-f]{32}"$/);
    const head = await json("aws s3api head-object --bucket api-bucket-1 --key data/data.json");
    expect(head).toMatchObject({ ContentLength: 7, ContentType: "application/json", ETag: put.ETag });
    const list = await json("aws s3api list-objects-v2 --bucket api-bucket-1 --delimiter /");
    expect(list).toMatchObject({ Name: "api-bucket-1", KeyCount: 1, CommonPrefixes: [{ Prefix: "data/" }] });
    expect(list.Contents).toBeUndefined();
    expect((await json("aws s3api list-objects-v2 --bucket api-bucket-1 --prefix data/")).Contents[0]).toMatchObject({
      Key: "data/data.json",
      Size: 7,
      StorageClass: "STANDARD",
    });
    const got = await ok("aws s3api get-object --bucket api-bucket-1 --key data/data.json out.json");
    expect(got.download?.filename).toBe("out.json");
    await ok("aws s3api copy-object --copy-source api-bucket-1/data/data.json --bucket api-bucket-1 --key copy.json");
    expect((await ok("aws s3api list-objects-v2 --bucket api-bucket-1 --query KeyCount")).output).toBe("2");
    await ok("aws s3api delete-object --bucket api-bucket-1 --key copy.json");
    // Deleting a key that doesn't exist succeeds, as in S3.
    await ok("aws s3api delete-object --bucket api-bucket-1 --key copy.json");
    expect((await ok("aws s3api list-objects-v2 --bucket api-bucket-1 --query KeyCount")).output).toBe("1");
  });

  it("detects local files to ask for in the terminal", () => {
    expect(localUploads("aws s3 cp ./site/index.html s3://b/")).toEqual(["./site/index.html"]);
    expect(localUploads("aws s3api put-object --bucket b --key k --body photo.jpg")).toEqual(["photo.jpg"]);
    expect(localUploads("aws s3 cp s3://b/k .")).toEqual([]);
    expect(localUploads("aws s3 cp s3://a/k s3://b/k")).toEqual([]);
    expect(localUploads("aws ec2 describe-vpcs")).toEqual([]);
  });
});

describe("static website hosting", () => {
  it("needs hosting on, public access and an index document, and serves like S3", async () => {
    await ok("aws s3 mb s3://my-site-bucket");
    expect((await website("my-site-bucket", "")).status).toBe(404);
    expect((await website("my-site-bucket", "")).body.toString()).toContain("NoSuchWebsiteConfiguration");

    await ok("aws s3 website s3://my-site-bucket --index-document index.html --error-document error.html");
    expect(await json("aws s3api get-bucket-website --bucket my-site-bucket")).toEqual({
      IndexDocument: { Suffix: "index.html" },
      ErrorDocument: { Key: "error.html" },
    });
    expect((await website("my-site-bucket", "")).status).toBe(403);

    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::my-site-bucket/*" }],
    });
    // Block public access is on by default, so the public policy is refused.
    const blocked = await run(`aws s3api put-bucket-policy --bucket my-site-bucket --policy '${policy}'`);
    expect(blocked.output).toContain("(AccessDenied) when calling the PutBucketPolicy operation");
    expect(blocked.output).toContain("because public policies are blocked by the BlockPublicPolicy block public access setting.");
    await ok("aws s3api delete-public-access-block --bucket my-site-bucket");
    await ok(`aws s3api put-bucket-policy --bucket my-site-bucket --policy '${policy}'`);
    expect(JSON.parse((await json("aws s3api get-bucket-policy --bucket my-site-bucket")).Policy).Statement[0].Principal).toBe("*");

    file("index.html", "<h1>Home</h1>");
    file("error.html", "<h1>Oops</h1>");
    file("about.html", "<h1>Docs</h1>");
    await ok("aws s3 cp index.html s3://my-site-bucket/");
    await ok("aws s3 cp error.html s3://my-site-bucket/");
    await ok("aws s3 cp about.html s3://my-site-bucket/docs/index.html");

    const home = await website("my-site-bucket", "");
    expect(home).toMatchObject({ status: 200, contentType: "text/html" });
    expect(home.body.toString()).toBe("<h1>Home</h1>");
    expect((await website("my-site-bucket", "docs/")).body.toString()).toBe("<h1>Docs</h1>");
    expect(await website("my-site-bucket", "docs")).toMatchObject({ status: 302, location: "docs/" });
    const missing = await website("my-site-bucket", "nope.html");
    expect(missing.status).toBe(404);
    expect(missing.body.toString()).toBe("<h1>Oops</h1>");

    // Turning public access back on takes the site down, as in S3.
    await ok("aws s3api put-public-access-block --bucket my-site-bucket --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true");
    expect((await website("my-site-bucket", "")).status).toBe(403);
  });

  it("rejects policies CloudLab doesn't understand, and bad JSON", async () => {
    await ok("aws s3 mb s3://policy-bucket-1");
    await ok("aws s3api delete-public-access-block --bucket policy-bucket-1");
    expect((await run("aws s3api put-bucket-policy --bucket policy-bucket-1 --policy 'not json'")).output).toContain("(MalformedPolicy)");
    const other = JSON.stringify({ Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::other-bucket/*" }] });
    expect((await run(`aws s3api put-bucket-policy --bucket policy-bucket-1 --policy '${other}'`)).output).toContain(
      "Policy has invalid resource",
    );
    expect((await run("aws s3api get-bucket-policy --bucket policy-bucket-1")).output).toContain("(NoSuchBucketPolicy)");
  });
});

describe("object storage limits and housekeeping", () => {
  it("keeps bucket counts current and resets objects with the region", async () => {
    await ok("aws s3 mb s3://count-bucket-1");
    await engine.objects.put(ACCOUNT, "count-bucket-1", "a.txt", Buffer.from("aaa"));
    await engine.objects.put(ACCOUNT, "count-bucket-1", "a.txt", Buffer.from("aaaaa"));
    await engine.objects.put(ACCOUNT, "count-bucket-1", "b.txt", Buffer.from("b"));
    const bucket = await engine.get(ACCOUNT, "count-bucket-1");
    expect(bucket.attributes).toMatchObject({ objectCount: 2, totalBytes: 6 });
    // Objects don't appear as resources of their own in the console.
    expect((await engine.list(ACCOUNT, { service: "storage", type: "bucket" })).map((b) => b.id)).toEqual(["count-bucket-1"]);

    await engine.resetRegion(ACCOUNT, "us-east-1");
    await ok("aws s3 mb s3://count-bucket-1");
    expect((await engine.objects.list(ACCOUNT, "count-bucket-1")).objects).toEqual([]);
  });
});
