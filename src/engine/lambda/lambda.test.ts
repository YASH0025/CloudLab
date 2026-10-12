import { beforeEach, describe, expect, it } from "vitest";
import { handleApiRequest } from "../apigw/handle";
import { Engine } from "../engine";
import { accountNumber } from "../ids";
import { MemoryStore } from "../store";
import { addPermission, invokeFunction } from "./invoke";

const A = "acct-lambda";
const R = "us-east-1";
let clock: Date;
let engine: Engine;
const create = (service: string, type: string, config: Record<string, unknown>, region = R) => engine.create(A, { service, type, region, config });
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

const LAMBDA_TRUST = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
});
const EC2_TRUST = LAMBDA_TRUST.replace("lambda.amazonaws.com", "ec2.amazonaws.com");

const HELLO = {
  "index.mjs": `export const handler = async (event) => {
  const name = event.queryStringParameters?.name ?? event.pathParameters?.id ?? "world";
  console.log("hello", name);
  if (name === "boom") throw new Error("kaboom");
  return { statusCode: 200, headers: { "content-type": "text/plain" }, body: "Hello, " + name };
};`,
};

beforeEach(() => {
  clock = new Date("2026-05-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

const request = (apiId: string, method: string, path: string, query = "") =>
  handleApiRequest(engine, { apiId, method, path, query, headers: { "user-agent": "curl/8" }, body: "", sourceIp: "198.51.100.7" });

describe("Lambda functions", { timeout: 30_000 }, () => {
  it("needs a role Lambda can assume, and validates like Lambda", async () => {
    await create("iam", "role", { name: "ec2-role", trustPolicy: EC2_TRUST }, "global");
    await create("iam", "role", { name: "lambda-role", trustPolicy: LAMBDA_TRUST }, "global");
    await expect(create("lambda", "function", { name: "hello", role: "ec2-role" })).rejects.toMatchObject({
      code: "InvalidParameterValueException",
      message: "The role defined for the function cannot be assumed by Lambda.",
    });
    await expect(create("lambda", "function", { name: "hello", role: "missing" })).rejects.toMatchObject({
      message: "The role defined for the function cannot be assumed by Lambda.",
    });
    await expect(create("lambda", "function", { name: "hello", role: "lambda-role", runtime: "nodejs16.x" })).rejects.toMatchObject({
      code: "InvalidParameterValueException",
    });
    await expect(create("lambda", "function", { name: "hello", role: "lambda-role", environment: [{ key: "AWS_REGION", value: "x" }] })).rejects.toMatchObject({
      message: expect.stringContaining("Reserved keys used in this request: AWS_REGION"),
    });

    const fn = await create("lambda", "function", { name: "hello", role: "lambda-role" });
    expect(fn.id).toBe(`arn:aws:lambda:us-east-1:${accountNumber(A)}:function:hello`);
    expect(fn.state).toBe("Pending");
    expect(fn.config.files).toHaveProperty("index.mjs");
    await expect(invokeFunction(engine, A, fn, {}, "test")).rejects.toMatchObject({ code: "ResourceConflictException" });
    await expect(create("lambda", "function", { name: "hello", role: "lambda-role" })).rejects.toMatchObject({
      code: "ResourceConflictException",
      message: "Function already exist: hello",
    });

    later(2000);
    const first = await invokeFunction(engine, A, await engine.get(A, fn.id), { a: 1 }, "test");
    expect(first.payload).toEqual({ statusCode: 200, body: JSON.stringify("Hello from Lambda!") });
    expect(first.initDurationMs).toBeDefined();
    const second = await invokeFunction(engine, A, await engine.get(A, fn.id), { a: 1 }, "test");
    expect(second.initDurationMs).toBeUndefined(); // warm

    const after = await engine.get(A, fn.id);
    expect(after.attributes.invocations).toHaveLength(2);
    expect(after.attributes.metrics).toMatchObject({ invocations: 2, errors: 0 });
    // New code: the next call is a cold start again.
    await engine.update(A, fn.id, { files: { "index.mjs": "export const handler = async () => 'v2';" } });
    const third = await invokeFunction(engine, A, await engine.get(A, fn.id), {}, "test");
    expect(third.payload).toBe("v2");
    expect(third.initDurationMs).toBeDefined();
  });

  it("serves an HTTP API: stages, routes, path variables, permissions and errors", async () => {
    await create("iam", "role", { name: "lambda-role", trustPolicy: LAMBDA_TRUST }, "global");
    const fn = await create("lambda", "function", { name: "hello", role: "lambda-role", files: HELLO });
    later(2000);
    const api = await create("apigateway", "api", { name: "hello-api" });
    expect(api.id).toMatch(/^[a-z0-9]{10}$/);

    // Nothing deployed yet.
    expect((await request(api.id, "GET", "/hello")).status).toBe(404);
    await create("apigateway", "stage", { apiId: api.id, name: "$default" });
    expect(await request(api.id, "GET", "/hello")).toMatchObject({ status: 404, body: '{"message":"Not Found"}' });

    const integration = await create("apigateway", "integration", { apiId: api.id, functionName: "hello" });
    expect(integration.id).toMatch(new RegExp(`^${api.id}/integrations/[a-z0-9]{7}$`));
    await create("apigateway", "route", { apiId: api.id, routeKey: "GET /hello", integrationId: integration.id });
    await create("apigateway", "route", { apiId: api.id, routeKey: "GET /users/{id}", integrationId: integration.id });
    await expect(create("apigateway", "route", { apiId: api.id, routeKey: "GET /hello" })).rejects.toMatchObject({ code: "ConflictException" });
    await expect(create("apigateway", "route", { apiId: api.id, routeKey: "hello" })).rejects.toMatchObject({ code: "BadRequestException" });

    // Without a permission on the function, API Gateway gets a 500 (and Nuvora says why).
    let res = await request(api.id, "GET", "/hello", "name=Ada");
    expect(res).toMatchObject({ status: 500, body: '{"message":"Internal Server Error"}' });
    expect(res.headers["x-cloudlab-reason"]).toContain("add-permission");

    await addPermission(engine, A, await engine.get(A, fn.id), {
      statementId: "apigw",
      action: "lambda:InvokeFunction",
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:us-east-1:${accountNumber(A)}:${api.id}/*/*`,
    });
    res = await request(api.id, "GET", "/hello", "name=Ada");
    expect(res).toMatchObject({ status: 200, body: "Hello, Ada" });
    expect(res.headers["content-type"]).toBe("text/plain");
    expect((await request(api.id, "GET", "/users/42")).body).toBe("Hello, 42");
    expect((await request(api.id, "POST", "/hello")).status).toBe(404);
    expect((await request(api.id, "GET", "/hello", "name=boom")).status).toBe(500);

    // A named stage serves the API under its name.
    await create("apigateway", "stage", { apiId: api.id, name: "prod" });
    expect((await request(api.id, "GET", "/prod/hello", "name=Bo")).body).toBe("Hello, Bo");

    const log = (await engine.get(A, api.id)).attributes.recentRequests as { status: number; routeKey: string; reason?: string }[];
    expect(log[0]).toMatchObject({ status: 200, routeKey: "GET /hello" });
    expect(log.some((l) => l.status === 500 && l.reason?.startsWith("The function failed: Error: kaboom"))).toBe(true);

    // Deleting the API deletes its routes, integrations and stages.
    await engine.remove(A, api.id);
    expect(await engine.list(A, { service: "apigateway", type: "route", region: R })).toEqual([]);
  });

  it("guesses a JSON response with payload format 2.0", async () => {
    await create("iam", "role", { name: "lambda-role", trustPolicy: LAMBDA_TRUST }, "global");
    const fn = await create("lambda", "function", { name: "data", role: "lambda-role", files: { "index.mjs": "export const handler = async () => ({ items: [1, 2] });" } });
    later(2000);
    const api = await create("apigateway", "api", { name: "data-api" });
    await create("apigateway", "stage", { apiId: api.id, name: "$default" });
    const integration = await create("apigateway", "integration", { apiId: api.id, functionName: "data" });
    await create("apigateway", "route", { apiId: api.id, routeKey: "$default", integrationId: integration.id });
    await addPermission(engine, A, fn, { statementId: "any", action: "lambda:InvokeFunction", principal: "apigateway.amazonaws.com" });
    const res = await request(api.id, "GET", "/anything/at/all");
    expect(res).toMatchObject({ status: 200, body: '{"items":[1,2]}' });
    expect(res.headers["content-type"]).toBe("application/json");
  });
});
