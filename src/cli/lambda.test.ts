import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { accountNumber } from "@/engine/ids";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ACCOUNT = "acct-lambda-cli";
let files: Record<string, string> = {};
const ctx = () => ({ engine, accountId: ACCOUNT, region: "us-east-1", files });
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const ACCT = () => accountNumber(ACCOUNT);

const run = (line: string) => executeCli(line, ctx());
async function json(line: string) {
  const r = await run(line);
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r.output ? JSON.parse(r.output) : {};
}
async function fails(line: string) {
  const r = await run(line);
  const m = /\(([^)]+)\) when calling the (\w+) operation: ([\s\S]*)/.exec(r.output);
  if (!m) throw new Error(r.output);
  return { code: m[1], message: m[3] };
}

const zip = (entries: Record<string, string>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])))).toString("base64");

const TRUST = `'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'`;
const CODE = `export const handler = async (event) => {
  console.log("event:", JSON.stringify(event));
  const name = event.queryStringParameters?.name ?? event.name ?? "world";
  return { statusCode: 200, body: JSON.stringify({ message: "Hello, " + name }) };
};`;

beforeEach(async () => {
  clock = new Date("2026-06-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
  files = { "function.zip": zip({ "index.mjs": CODE }), "folder.zip": zip({ "myfn/index.mjs": CODE }), "event.json": Buffer.from('{"name":"File"}').toString("base64") };
  await json(`aws iam create-role --role-name lambda-basic --assume-role-policy-document ${TRUST}`);
  await json("aws iam attach-role-policy --role-name lambda-basic --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole");
});

const CREATE = (name = "hello", zipName = "function.zip") =>
  `aws lambda create-function --function-name ${name} --runtime nodejs22.x --handler index.handler --role arn:aws:iam::${ACCT()}:role/lambda-basic --zip-file fileb://${zipName}`;

describe("aws lambda", { timeout: 30_000 }, () => {
  it("creates, invokes and explains the classic CLI mistakes", async () => {
    const fn = await json(CREATE());
    expect(fn).toMatchObject({ FunctionName: "hello", Runtime: "nodejs22.x", State: "Pending", StateReasonCode: "Creating", PackageType: "Zip", Handler: "index.handler" });
    expect(fn.FunctionArn).toBe(`arn:aws:lambda:us-east-1:${ACCT()}:function:hello`);
    expect(fn.CodeSha256).toMatch(/^[A-Za-z0-9+/]{43}=$/);

    expect(await fails(`aws lambda invoke --function-name hello out.json`)).toMatchObject({ code: "ResourceConflictException" });
    advance(2_000);

    // AWS CLI v2 reads --payload as base64 unless told otherwise.
    const bad = await run(`aws lambda invoke --function-name hello --payload '{"name":"Ada"}' out.json`);
    expect(bad.exitCode).toBe(255);
    expect(bad.output).toContain('Invalid base64: "{"name":"Ada"}"');

    const ok = await run(`aws lambda invoke --function-name hello --cli-binary-format raw-in-base64-out --payload '{"name":"Ada"}' --log-type Tail response.json`);
    expect(ok.exitCode).toBe(0);
    const meta = JSON.parse(ok.output);
    expect(meta).toMatchObject({ StatusCode: 200, ExecutedVersion: "$LATEST" });
    expect(Buffer.from(meta.LogResult, "base64").toString()).toMatch(/START RequestId[\s\S]*event: \{"name":"Ada"\}[\s\S]*REPORT RequestId/);
    expect(ok.download?.filename).toBe("response.json");
    expect(JSON.parse(Buffer.from(ok.download!.data, "base64").toString())).toEqual({ statusCode: 200, body: '{"message":"Hello, Ada"}' });

    // base64 payloads and files work too; /dev/stdout prints the answer.
    const b64 = Buffer.from('{"name":"B64"}').toString("base64");
    expect((await run(`aws lambda invoke --function-name hello --payload ${b64} /dev/stdout`)).output).toContain("Hello, B64");
    expect((await run(`aws lambda invoke --function-name hello --payload fileb://event.json /dev/stdout`)).output).toContain("Hello, File");

    // A zip of the folder instead of its contents: the classic "Cannot find module 'index'".
    await json(CREATE("folder", "folder.zip"));
    advance(2_000);
    const broken = await run(`aws lambda invoke --function-name folder /dev/stdout`);
    expect(broken.output).toContain('"errorType":"Runtime.ImportModuleError"');
    expect(broken.output).toContain('"FunctionError": "Unhandled"');

    expect(await fails("aws lambda get-function --function-name nope")).toMatchObject({
      code: "ResourceNotFoundException",
      message: `Function not found: arn:aws:lambda:us-east-1:${ACCT()}:function:nope`,
    });
    expect(await fails(CREATE())).toMatchObject({ code: "ResourceConflictException", message: "Function already exist: hello" });
  });

  it("updates configuration and code", async () => {
    await json(CREATE());
    advance(2_000);
    const cfg = await json(`aws lambda update-function-configuration --function-name hello --timeout 10 --memory-size 256 --environment Variables={STAGE=prod,TABLE=orders}`);
    expect(cfg).toMatchObject({ Timeout: 10, MemorySize: 256, Environment: { Variables: { STAGE: "prod", TABLE: "orders" } } });
    files["v2.zip"] = zip({ "index.mjs": "export const handler = async () => process.env.STAGE;" });
    const before = cfg.CodeSha256;
    const after = await json("aws lambda update-function-code --function-name hello --zip-file fileb://v2.zip");
    expect(after.CodeSha256).not.toBe(before);
    expect((await run("aws lambda invoke --function-name hello /dev/stdout")).output.split("\n")[0]).toBe('"prod"');
    expect((await json("aws lambda list-functions")).Functions).toHaveLength(1);
  });
});

describe("aws apigatewayv2 + curl", { timeout: 30_000 }, () => {
  it("quick-creates an API, needs add-permission, then answers curl", async () => {
    await json(CREATE());
    advance(2_000);
    const arn = `arn:aws:lambda:us-east-1:${ACCT()}:function:hello`;
    const api = await json(`aws apigatewayv2 create-api --name hello-api --protocol-type HTTP --target ${arn}`);
    expect(api).toMatchObject({ Name: "hello-api", ProtocolType: "HTTP", RouteSelectionExpression: "$request.method $request.path" });
    expect(api.ApiEndpoint).toBe(`https://${api.ApiId}.execute-api.us-east-1.cloudlab.local`);

    expect((await run(`curl ${api.ApiEndpoint}/hi`)).output).toBe('{"message":"Internal Server Error"}');
    await json(
      `aws lambda add-permission --function-name hello --statement-id apigateway-invoke --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn arn:aws:execute-api:us-east-1:${ACCT()}:${api.ApiId}/*`,
    );
    expect(await fails(`aws lambda add-permission --function-name hello --statement-id apigateway-invoke --action lambda:InvokeFunction --principal apigateway.amazonaws.com`)).toMatchObject({
      code: "ResourceConflictException",
    });
    const policy = JSON.parse((await json("aws lambda get-policy --function-name hello")).Policy);
    expect(policy.Statement[0]).toMatchObject({ Sid: "apigateway-invoke", Principal: { Service: "apigateway.amazonaws.com" } });

    expect((await run(`curl "${api.ApiEndpoint}/anything?name=Curl"`)).output).toBe('{"message":"Hello, Curl"}');
    const withHeaders = (await run(`curl -i ${api.ApiEndpoint}/x`)).output;
    expect(withHeaders).toMatch(/^HTTP\/2 200 OK\ncontent-type: application\/json/);
    expect((await run("curl https://example.com")).output).toContain("Could not resolve host: example.com");
  });

  it("builds an API step by step: integration, route, stage", async () => {
    await json(CREATE());
    advance(2_000);
    const arn = `arn:aws:lambda:us-east-1:${ACCT()}:function:hello`;
    const api = await json("aws apigatewayv2 create-api --name step-api --protocol-type HTTP");
    expect(await fails(`aws apigatewayv2 create-integration --api-id ${api.ApiId} --integration-type AWS_PROXY --integration-uri ${arn}`)).toMatchObject({
      code: "BadRequestException",
    });
    const integ = await json(`aws apigatewayv2 create-integration --api-id ${api.ApiId} --integration-type AWS_PROXY --integration-uri ${arn} --payload-format-version 2.0`);
    expect(integ).toMatchObject({ IntegrationType: "AWS_PROXY", IntegrationUri: arn, PayloadFormatVersion: "2.0", TimeoutInMillis: 30000 });
    expect(integ.IntegrationId).toMatch(/^[a-z0-9]{7}$/);
    const route = await json(`aws apigatewayv2 create-route --api-id ${api.ApiId} --route-key "GET /hello" --target integrations/${integ.IntegrationId}`);
    expect(route).toMatchObject({ RouteKey: "GET /hello", Target: `integrations/${integ.IntegrationId}`, AuthorizationType: "NONE" });
    await json(`aws lambda add-permission --function-name hello --statement-id api --action lambda:InvokeFunction --principal apigateway.amazonaws.com`);

    // No stage yet: nothing is deployed.
    expect((await run(`curl ${api.ApiEndpoint}/hello`)).output).toBe('{"message":"Not Found"}');
    await json(`aws apigatewayv2 create-stage --api-id ${api.ApiId} --stage-name prod`);
    expect((await run(`curl "${api.ApiEndpoint}/prod/hello?name=Prod"`)).output).toBe('{"message":"Hello, Prod"}');
    expect((await json(`aws apigatewayv2 get-routes --api-id ${api.ApiId}`)).Items).toHaveLength(1);
    expect(await fails("aws apigatewayv2 get-api --api-id abcdefghij")).toMatchObject({ code: "NotFoundException" });

    await json(`aws apigatewayv2 delete-api --api-id ${api.ApiId}`);
    expect((await json("aws apigatewayv2 get-apis")).Items).toEqual([]);
  });
});
