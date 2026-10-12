import { randomUUID } from "node:crypto";
import { createStack, deleteStackResources, IAM_TYPES, updateStack } from "../cloudformation/deploy";
import { HANDLERS } from "../cloudformation/resources";
import { evaluateConditions, orderResources, parseTemplate, resolveParameters, validationError } from "../cloudformation/template";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import type { ActionDef, ResourceTypeDef, ServiceDef } from "../types";

/**
 * CloudFormation stacks: a template (JSON or YAML) and its parameters. Creating
 * the stack creates every resource in it; changing the template updates
 * them; deleting the stack deletes them. The template is checked up front
 * (format, parameters, references, capabilities) exactly when AWS rejects the
 * request; a resource that fails while being created rolls the stack back.
 */

export const STACK_NAME = /^[a-zA-Z][-a-zA-Z0-9]*$/;
export const stackArn = (region: string, accountId: string, name: string) => `arn:aws:cloudformation:${region}:${accountNumber(accountId)}:stack/${name}/${randomUUID()}`;

const STABLE = ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"];
const ALL = ["CREATE_IN_PROGRESS", "CREATE_COMPLETE", "CREATE_FAILED", "ROLLBACK_COMPLETE", "UPDATE_IN_PROGRESS", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "DELETE_FAILED"];

const hidden = (from: string[], to: string): ActionDef => ({ label: to, from, to, pastTense: to.toLowerCase(), hidden: true });

export const EXAMPLE_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Description: A queue and a topic that feeds it

Parameters:
  Env:
    Type: String
    AllowedValues: [dev, prod]
    Default: dev

Resources:
  OrdersTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: !Sub orders-\${Env}

  OrdersQueue:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 60

  OrdersSubscription:
    Type: AWS::SNS::Subscription
    Properties:
      TopicArn: !Ref OrdersTopic
      Protocol: sqs
      Endpoint: !GetAtt OrdersQueue.Arn

Outputs:
  QueueUrl:
    Value: !Ref OrdersQueue
`;

const stack: ResourceTypeDef = {
  service: "cloudformation",
  type: "stack",
  label: "Stack",
  pluralLabel: "Stacks",
  description:
    "Infrastructure as code: describe resources in a template (YAML or JSON), and CloudFormation creates them in the right order, updates them when you change the template, and deletes them all with the stack.",
  idPrefix: "stack",
  makeId: ({ name, region, accountId }) => stackArn(region, accountId, name),
  idPattern: /^arn:aws:cloudformation:[a-z0-9-]+:\d{12}:stack\/[a-zA-Z][-a-zA-Z0-9]*\/[0-9a-f-]{36}$/,
  notFoundCode: "ValidationError",
  notFoundMessage: (id) => `Stack with id ${id.split("/")[1] ?? id} does not exist`,
  notFoundByNameMessage: (name) => `Stack with id ${name} does not exist`,
  malformedCode: "ValidationError",
  malformedMessage: (id) => `Stack with id ${id} does not exist`,
  apiNoun: "stack",
  stateErrorCode: "ValidationError",
  panelAttributes: ["events", "resources", "outputs", "imports", "parametersResolved", "lastOperation", "rollbackConfig", "description"],
  privateAttributes: ["deleteBlockedBy"],
  fields: [
    {
      key: "name",
      label: "Stack name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 128,
      pattern: STACK_NAME.source,
      patternMessage: "Starts with a letter; letters, numbers and hyphens only.",
      placeholder: "orders-stack",
      param: "StackName",
    },
    {
      key: "templateBody",
      label: "Template",
      type: "text",
      required: true,
      maxLength: 51200,
      default: EXAMPLE_TEMPLATE,
      param: "TemplateBody",
      description:
        "YAML or JSON. Short forms like !Ref, !GetAtt and !Sub work. Supported types: VPC, Subnet, InternetGateway (+ VPCGatewayAttachment), RouteTable, Route, SubnetRouteTableAssociation, SecurityGroup, Instance, EIP, NatGateway, S3 Bucket, SNS Topic/Subscription, SQS Queue/QueuePolicy, DynamoDB Table, IAM Role, Lambda Function/Permission, Logs LogGroup, CloudWatch Alarm.",
    },
    {
      key: "parameters",
      label: "Parameters",
      itemLabel: "parameter",
      type: "list",
      param: "Parameters",
      item: [
        { key: "key", label: "Name", type: "string", required: true, maxLength: 255, placeholder: "Env" },
        { key: "value", label: "Value", type: "string", maxLength: 4096, placeholder: "dev" },
      ],
      description: "Values for the template's Parameters. Ones you leave out use their Default.",
    },
    {
      key: "acknowledgeIam",
      label: "I acknowledge that CloudFormation might create IAM resources (with custom names)",
      type: "boolean",
      param: "Capabilities",
      description: "Required when the template creates IAM roles: CAPABILITY_IAM, or CAPABILITY_NAMED_IAM if they have names. It's a deliberate speed bump: IAM changes who can do what.",
    },
    {
      key: "disableRollback",
      label: "Preserve successfully provisioned resources on failure",
      type: "boolean",
      immutable: true,
      param: "DisableRollback",
      description: "Normally a failed create deletes everything it made. With this on, the stack stops at CREATE_FAILED and keeps them, so you can look at what went wrong.",
    },
    {
      key: "terminationProtection",
      label: "Termination protection",
      type: "boolean",
      param: "EnableTerminationProtection",
      description: "While on, the stack can't be deleted.",
    },
  ],
  columns: [
    { label: "Status", path: "state" },
    { label: "Description", path: "attributes.description" },
  ],
  lifecycle: {
    create: { state: "CREATE_IN_PROGRESS" },
    actions: {
      "complete-create": hidden(["CREATE_IN_PROGRESS"], "CREATE_COMPLETE"),
      "fail-create": hidden(["CREATE_IN_PROGRESS"], "CREATE_FAILED"),
      "rollback-create": hidden(["CREATE_IN_PROGRESS"], "ROLLBACK_COMPLETE"),
      "begin-update": hidden(STABLE, "UPDATE_IN_PROGRESS"),
      "complete-update": hidden(["UPDATE_IN_PROGRESS"], "UPDATE_COMPLETE"),
      "rollback-update": hidden(["UPDATE_IN_PROGRESS"], "UPDATE_ROLLBACK_COMPLETE"),
      "fail-delete": hidden(ALL, "DELETE_FAILED"),
    },
  },
  iam: {
    create: "cloudformation:CreateStack",
    read: "cloudformation:DescribeStacks",
    update: (changed) => (changed.length === 1 && changed[0] === "terminationProtection" ? ["cloudformation:UpdateTerminationProtection"] : ["cloudformation:UpdateStack"]),
    delete: "cloudformation:DeleteStack",
    arn: (r) => r.id,
  },
  invalidValue({ field, value }) {
    if (field.key === "name") {
      return new EngineError(
        "ValidationError",
        `1 validation error detected: Value '${String(value)}' at 'stackName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z][-a-zA-Z0-9]*`,
      );
    }
    return undefined;
  },
  canDelete(r) {
    if (r.config.terminationProtection === true) return validationError(`Stack [${r.name}] cannot be deleted while TerminationProtection is enabled`);
    if (r.state?.endsWith("_IN_PROGRESS")) return validationError(`Stack [${r.name}] is in ${r.state} state and can not be deleted.`);
    return undefined;
  },
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("cloudformation", "stack")).some((s) => s.name === config.name)) {
      throw new EngineError("AlreadyExistsException", `Stack [${String(config.name)}] already exists`, 400);
    }
    // The stack's own rollback restores the old template: no checks needed.
    if (existing?.attributes.rollbackConfig) return;
    const deployChanged = !existing || existing.config.templateBody !== config.templateBody || JSON.stringify(existing.config.parameters ?? []) !== JSON.stringify(config.parameters ?? []);
    if (existing && !deployChanged && existing.config.terminationProtection !== config.terminationProtection) return;
    if (existing && !STABLE.includes(existing.state ?? "")) {
      throw validationError(`Stack:${existing.id} is in ${existing.state} state and can not be updated.`);
    }
    if (existing && !deployChanged) throw validationError("No updates are to be performed.");
    const t = parseTemplate(String(config.templateBody));
    const given = Object.fromEntries(((config.parameters as { key: string; value?: string }[] | undefined) ?? []).map((p) => [p.key, p.value ?? ""]));
    const p = resolveParameters(t, given);
    const unsupported = [...new Set(Object.values(t.Resources).map((r) => r.Type))].filter((type) => !HANDLERS[type]);
    if (unsupported.length) throw validationError(`Template format error: Unrecognized resource types: [${unsupported.join(", ")}] (Nuvora simulates ${Object.keys(HANDLERS).length} types; see the Template field's help)`);
    const conditions = evaluateConditions(t, {
      params: p,
      pseudo: { "AWS::Region": ctx.region, "AWS::AccountId": accountNumber(ctx.accountId), "AWS::StackName": String(config.name), "AWS::StackId": "", "AWS::Partition": "aws", "AWS::URLSuffix": "amazonaws.com" },
      mappings: t.Mappings,
      azs: [],
      ref: () => "",
      getAtt: () => "",
      importValue: () => "",
    });
    const active = Object.keys(t.Resources).filter((id) => !t.Resources[id].Condition || conditions[t.Resources[id].Condition!]);
    for (const id of Object.keys(t.Resources)) {
      const c = t.Resources[id].Condition;
      if (c && !(c in conditions)) throw validationError(`Template format error: Unresolved dependencies [${c}]. Cannot reference resources in the Conditions block of the template`);
    }
    orderResources(t, active);
    const iam = Object.entries(t.Resources).filter(([, r]) => IAM_TYPES.includes(r.Type));
    if (iam.length && config.acknowledgeIam !== true) {
      const named = iam.some(([, r]) => r.Properties && ("RoleName" in r.Properties || "UserName" in r.Properties || "GroupName" in r.Properties));
      throw new EngineError("InsufficientCapabilitiesException", `Requires capabilities : [${named ? "CAPABILITY_NAMED_IAM" : "CAPABILITY_IAM"}]`, 400);
    }
  },
  async derive({ existing }) {
    return { ...(existing?.attributes ?? {}), events: existing?.attributes.events ?? [], resources: existing?.attributes.resources ?? [], outputs: existing?.attributes.outputs ?? [] };
  },
  async afterCreate({ resource, system }) {
    await createStack(system.engine, await system.engine.get(system.accountId, resource.id));
  },
  async afterUpdate({ resource, previous, system }) {
    const fresh = await system.engine.get(system.accountId, resource.id);
    if (fresh.attributes.rollbackConfig) return;
    const changed = previous.config.templateBody !== resource.config.templateBody || JSON.stringify(previous.config.parameters ?? []) !== JSON.stringify(resource.config.parameters ?? []);
    if (!changed) return;
    await updateStack(system.engine, fresh, previous);
  },
  async beforeDelete({ resource, system, params }) {
    await deleteStackResources(system.engine, resource, (params.retainResources as string[] | undefined) ?? []);
  },
};

export const cloudFormationService: ServiceDef = {
  id: "cloudformation",
  label: "CloudFormation",
  modelledOn: "AWS CloudFormation",
  description: "Infrastructure as code: describe your resources in a template and create, change or delete them together as a stack.",
  category: "DevOps",
  types: [stack],
};
