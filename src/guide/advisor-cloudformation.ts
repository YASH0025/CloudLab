import type { Engine } from "@/engine/engine";
import type { StackEvent } from "@/engine/cloudformation/deploy";
import type { Suggestion } from "./types";

/**
 * Advisor rules for CloudFormation: a stack that failed (with the first
 * resource that failed and why), and a nudge towards templates once the lab
 * has grown by hand.
 */
export async function cloudFormationAdvice(engine: Engine, accountId: string, region: string, ownResourceCount: number) {
  const stacks = await engine.list(accountId, { service: "cloudformation", type: "stack", region });
  const problems: Suggestion[] = [];
  const suggestions: Suggestion[] = [];
  for (const s of stacks) {
    if (!/ROLLBACK_COMPLETE|FAILED/.test(String(s.state))) continue;
    const events = (s.attributes.events as StackEvent[] | undefined) ?? [];
    const first = [...events].reverse().find((e) => /_FAILED$/.test(e.status) && e.logicalId !== s.name);
    const dead = s.state === "ROLLBACK_COMPLETE";
    problems.push({
      id: `cfn-failed-${s.id}`,
      level: "advanced",
      title: `Stack ${s.name} is in ${s.state}`,
      why: first ? `${first.logicalId} (${first.type}) failed: ${first.reason ?? "see the stack's events"}` : "Open the stack's events to see what failed.",
      steps: dead
        ? ["Fix the template (the first CREATE_FAILED event names the cause).", "A stack whose first create failed can't be updated: delete it and create it again."]
        : s.state === "DELETE_FAILED"
          ? ["Find what's blocking the resource (often something created outside the stack still uses it, or a bucket isn't empty).", "Fix that, then delete the stack again (or retain that resource)."]
          : ["Fix the template and update the stack again. The rolled-back stack is exactly as it was before."],
      link: { service: "cloudformation", type: "stack", mode: "detail", id: s.id },
      cli: `aws cloudformation describe-stack-events --stack-name ${s.name}`,
    });
  }
  if (stacks.length === 0 && ownResourceCount >= 8) {
    suggestions.push({
      id: "try-iac",
      level: "advanced",
      title: "Describe your setup as code",
      why: "You've built a lot by clicking. A CloudFormation template lets you rebuild it identically, review changes before they happen, and delete it all in one go.",
      steps: ["Open Guide me → Tutorials and start 'Infrastructure as code: CloudFormation'."],
      link: { service: "cloudformation", type: "stack", mode: "list" },
    });
  }
  return { problems, suggestions };
}
