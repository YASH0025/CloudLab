import { createHash, createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AwsEndpoint, decodeAwsChunked, LocalS3, S3Api, uriEncode, verifySigV4 } from "../../public/agent/cloudlab-agent.mjs";

// AWS's own worked examples for S3 Signature Version 4 (docs: "Examples: Signature calculations").
const DOCS_ID = "AKIAIOSFODNN7EXAMPLE";
const DOCS_KEYS = { [DOCS_ID]: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DOCS_NOW = Date.parse("2013-05-24T00:00:00Z");

const signedReq = (method: string, target: string, headers: Record<string, string>, signed: string, signature: string, scope = "20130524/us-east-1/s3/aws4_request") => ({
  req: {
    method,
    url: target,
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${Object.keys(headers).includes("amz-sdk-invocation-id") ? "AKTEST" : DOCS_ID}/${scope}, SignedHeaders=${signed}, Signature=${signature}` },
  },
  url: new URL(target, "http://localhost"),
});

describe("AWS Signature Version 4", () => {
  it("accepts AWS's documented S3 examples", () => {
    const base = { host: "examplebucket.s3.amazonaws.com", "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" };
    const cases = [
      signedReq("GET", "/test.txt", { ...base, range: "bytes=0-9" }, "host;range;x-amz-content-sha256;x-amz-date", "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"),
      signedReq("GET", "/?lifecycle", base, "host;x-amz-content-sha256;x-amz-date", "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"),
      signedReq("GET", "/?max-keys=2&prefix=J", base, "host;x-amz-content-sha256;x-amz-date", "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"),
    ];
    for (const { req, url } of cases) expect(verifySigV4(req, url, DOCS_KEYS, DOCS_NOW)).toMatchObject({ accessKeyId: DOCS_ID, region: "us-east-1", service: "s3" });
  });

  it("accepts sub-resources without a value, as the JavaScript SDK signed CreateMultipartUpload", () => {
    const { req, url } = signedReq(
      "POST",
      "/abc/k?uploads",
      {
        "x-amz-user-agent": "aws-sdk-js/3.1148.0",
        host: "localhost:4599",
        "amz-sdk-invocation-id": "8bff2a55-d3d2-4126-a174-c221b32f38ab",
        "amz-sdk-request": "attempt=1; max=3",
        "x-amz-content-sha256": EMPTY,
        "x-amz-date": "20261012T174703Z",
      },
      "amz-sdk-invocation-id;amz-sdk-request;host;x-amz-content-sha256;x-amz-date;x-amz-user-agent",
      "c416548000128d0133935a73b12c02fef768d70c63f21f04838473b243868e91",
      "20261012/local-1/s3/aws4_request",
    );
    expect(verifySigV4(req, url, { AKTEST: "secret" }, Date.parse("2026-10-12T17:47:03Z"))).toMatchObject({ service: "s3", region: "local-1" });
  });

  it("refuses wrong keys, unknown keys, old requests, and lets unsigned ones through as anonymous", () => {
    const base = { host: "examplebucket.s3.amazonaws.com", "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z", range: "bytes=0-9" };
    const { req, url } = signedReq("GET", "/test.txt", base, "host;range;x-amz-content-sha256;x-amz-date", "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(() => verifySigV4(req, url, { [DOCS_ID]: "wrong" }, DOCS_NOW)).toThrow(expect.objectContaining({ code: "SignatureDoesNotMatch", status: 403 }));
    expect(() => verifySigV4(req, url, {}, DOCS_NOW)).toThrow(expect.objectContaining({ code: "InvalidAccessKeyId" }));
    expect(() => verifySigV4(req, url, DOCS_KEYS, DOCS_NOW + 3_600_000)).toThrow(expect.objectContaining({ code: "RequestTimeTooSkewed" }));
    expect(verifySigV4({ method: "GET", url: "/x", headers: {} }, new URL("http://localhost/x"), DOCS_KEYS)).toBeNull();
  });

  it("encodes like SigV4: only unreserved characters stay, slashes on request", () => {
    expect(uriEncode("a b/c*d~e")).toBe("a%20b%2Fc%2Ad~e");
    expect(uriEncode("a b/c", true)).toBe("a%20b/c");
    expect(uriEncode("")).toBe("");
  });
});

describe("aws-chunked uploads", () => {
  it("joins the chunks and drops signatures and trailers", () => {
    const raw = Buffer.from("5;chunk-signature=abc\r\nhello\r\n6;chunk-signature=def\r\n world\r\n0;chunk-signature=0\r\nx-amz-checksum-crc32:AAAA\r\n\r\n");
    expect(decodeAwsChunked(raw).toString()).toBe("hello world");
  });
});

// ---------- the S3 API over HTTP, signed like an SDK would ----------

const ID = "CLAKTESTTESTTESTTEST";
const SECRET = "test-secret";
const hex = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (k: string | Buffer, d: string) => createHmac("sha256", k).update(d).digest();

async function s3(port: number, method: string, target: string, body?: string, extra: Record<string, string> = {}) {
  const url = new URL(target, `http://localhost:${port}`);
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const payload = hex(body ?? "");
  const headers: Record<string, string> = { host: `localhost:${port}`, "x-amz-content-sha256": payload, "x-amz-date": amzDate, ...extra };
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .sort()
    .join("&");
  const canonical = [method, url.pathname, query, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), payload].join("\n");
  const scope = `${amzDate.slice(0, 8)}/local-1/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, amzDate.slice(0, 8)), "local-1"), "s3"), "aws4_request");
  const sig = createHmac("sha256", key).update(["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n")).digest("hex");
  const { host: _host, ...send } = headers;
  void _host;
  const res = await fetch(url, { method, body, headers: { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` } });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

describe("the S3 API on the AWS endpoint", () => {
  let endpoint: InstanceType<typeof AwsEndpoint>;
  let port: number;
  const made: string[] = [];

  beforeAll(async () => {
    const d = mkdtempSync(path.join(tmpdir(), "cl-aws-"));
    const local = new LocalS3(path.join(d, "s3"), path.join(d, "meta.json"));
    const spec = (name: string) => ({ name, versioning: "Disabled", blockPublicAccess: true, publicRead: false, websiteEnabled: false, indexDocument: null, errorDocument: null });
    const api = new S3Api(local, {
      createBucket: async (name: string) => {
        made.push(name);
        local.createBucket(spec(name));
      },
      deleteBucket: async (name: string) => local.deleteBucket(name),
      onChange: () => undefined,
      owner: ID,
    });
    endpoint = new AwsEndpoint({ keys: () => ({ [ID]: SECRET }), services: { s3: api } });
    port = (await endpoint.start(0))!;
  });
  afterAll(() => endpoint.server?.close());

  it("creates a bucket, stores, lists, reads and deletes objects", async () => {
    expect((await s3(port, "PUT", "/notes")).status).toBe(200);
    expect(made).toEqual(["notes"]);
    const put = await s3(port, "PUT", "/notes/day%201/hello.txt", "Hello", { "content-type": "text/plain", "x-amz-meta-owner": "prateek" });
    expect(put.status).toBe(200);
    expect(put.headers.get("etag")).toBe(`"${createHash("md5").update("Hello").digest("hex")}"`);

    const get = await s3(port, "GET", "/notes/day%201/hello.txt");
    expect(get).toMatchObject({ status: 200, text: "Hello" });
    expect(get.headers.get("x-amz-meta-owner")).toBe("prateek");
    expect((await s3(port, "GET", "/notes/day%201/hello.txt", undefined, { range: "bytes=1-3" })).text).toBe("ell");

    const list = await s3(port, "GET", "/notes?list-type=2&delimiter=%2F");
    expect(list.text).toContain("<Prefix>day 1/</Prefix>");
    expect(list.text).toContain("<KeyCount>1</KeyCount>");

    const del = await s3(port, "POST", "/notes?delete", "<Delete><Object><Key>day 1/hello.txt</Key></Object></Delete>", { "content-type": "application/xml" });
    expect(del.status).toBe(200);
    expect(del.text).toContain("<Deleted><Key>day 1/hello.txt</Key></Deleted>");
    expect((await s3(port, "DELETE", "/notes")).status).toBe(204);
  });

  it("puts large files together from parts", async () => {
    await s3(port, "PUT", "/big");
    const start = await s3(port, "POST", "/big/file.bin?uploads");
    expect(start.status).toBe(200);
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(start.text)![1];
    const a = await s3(port, "PUT", `/big/file.bin?partNumber=1&uploadId=${uploadId}`, "a".repeat(10));
    const b = await s3(port, "PUT", `/big/file.bin?partNumber=2&uploadId=${uploadId}`, "b".repeat(5));
    const parts = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${a.headers.get("etag")}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${b.headers.get("etag")}</ETag></Part></CompleteMultipartUpload>`;
    const done = await s3(port, "POST", `/big/file.bin?uploadId=${uploadId}`, parts);
    expect(done.status).toBe(200);
    expect(done.text).toMatch(/<ETag>&quot;[0-9a-f]{32}-2&quot;<\/ETag>|<ETag>"[0-9a-f]{32}-2"<\/ETag>/);
    expect((await s3(port, "GET", "/big/file.bin")).text).toBe("a".repeat(10) + "b".repeat(5));
  });

  it("answers with S3's errors", async () => {
    await s3(port, "PUT", "/errs");
    const missing = await s3(port, "GET", "/errs/nope.txt");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("<Code>NoSuchKey</Code>");
    expect((await s3(port, "GET", "/no-such-bucket?list-type=2")).text).toContain("<Code>NoSuchBucket</Code>");
    await s3(port, "PUT", "/errs/a.txt", "x");
    expect((await s3(port, "DELETE", "/errs")).text).toContain("<Code>BucketNotEmpty</Code>");
    const anon = await fetch(`http://localhost:${port}/errs/a.txt`);
    expect(anon.status).toBe(403);
    expect(await anon.text()).toContain("<Code>AccessDenied</Code>");
  });
});
