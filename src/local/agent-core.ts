/**
 * CloudLab's service code that the agent runs on the learner's computer, so a
 * service on My computer (local) follows exactly the same rules, and gives the
 * same errors, as the simulated one. Bundled into public/agent/lib/core.mjs by
 * `npm run agent:core` (a test fails when the bundle is out of date).
 */
export { dynamodbApi, DYNAMODB_OPERATIONS } from "@/engine/dynamodb/api";
export { explore } from "@/engine/dynamodb/explore";
export { EngineError } from "@/engine/errors";
export { FileTableHost } from "./dynamodb-host";
export { QueueWaiters, sqsApi, sqsErrorNames } from "@/engine/sqs/api";
export { queueConsole } from "@/engine/sqs/console";
export { FileQueueHost } from "./sqs-host";
export { snsApi, snsErrorXml, snsResponseXml, SNS_UNSIGNED } from "@/engine/sns/api";
export { publish, subscriptionConfirmation } from "@/engine/sns/publish";
export { FileSubscriptionHost, FileTopicHost, LocalHosts } from "./sns-host";
