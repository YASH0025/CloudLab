import type { Engine } from "@/engine/engine";
import { systemOf } from "@/engine/types";
import type { Suggestion } from "./types";

/**
 * Advisor rules for CloudWatch: an alarm that's going off, and a function
 * whose logs are being lost because its role can't write them. Alarms that
 * Auto Scaling manages for target tracking are left out: being in ALARM is
 * how they ask for more (or fewer) instances.
 */
export async function monitoringAdvice(engine: Engine, accountId: string, region: string) {
  const [alarms, fns] = await Promise.all([
    engine.list(accountId, { service: "cloudwatch", type: "alarm", region }),
    engine.list(accountId, { service: "lambda", type: "function", region }),
  ]);
  const problems: Suggestion[] = [];

  for (const fn of fns) {
    const denied = fn.attributes.logsDenied;
    if (!denied) continue;
    problems.push({
      id: `fn-logs-denied-${fn.id}`,
      level: "intermediate",
      title: `${fn.name}'s logs are being lost`,
      why: `${String(denied)} Without logs, you can't see what the function printed or why it failed.`,
      steps: [`Open the role ${String(fn.config.role)} and attach the AWS managed policy AWSLambdaBasicExecutionRole.`, `Run ${fn.name} again; its logs appear in /aws/lambda/${fn.name}.`],
      link: { service: "lambda", type: "function", mode: "detail", id: fn.id },
      cli: `aws iam attach-role-policy --role-name ${String(fn.config.role).split("/").pop()} --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`,
    });
  }

  for (const alarm of alarms) {
    if (alarm.attributes.stateValue !== "ALARM" || systemOf(alarm).managedBy) continue;
    problems.push({
      id: `alarm-firing-${alarm.id}`,
      level: "intermediate",
      title: `Alarm ${alarm.name} is going off`,
      why: `${String(alarm.attributes.conditionText ?? "Its condition")} is true right now. ${String(alarm.attributes.stateReason ?? "")}`.trim(),
      steps: [
        `Open the alarm to see the graph and the reason.`,
        `Look at ${String(alarm.config.namespace)} ${String(alarm.config.metricName)}'s source: for Lambda errors, read the function's log group and search for ERROR.`,
        "Once the problem is fixed it goes back to OK by itself.",
      ],
      link: { service: "cloudwatch", type: "alarm", mode: "detail", id: alarm.id },
      cli: `aws cloudwatch describe-alarm-history --alarm-name ${alarm.name} --history-item-type StateUpdate`,
    });
  }
  return { problems, hasAlarm: alarms.some((a) => !systemOf(a).managedBy) };
}
