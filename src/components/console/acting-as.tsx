"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ShieldIcon, UserIcon, UserRoundCogIcon } from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useIdentities } from "@/hooks/use-cloud";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useConsoleStore } from "@/stores/console-store";

/**
 * "Acting as": switch the console and terminal to an IAM user or role, so every
 * request is checked against that identity's policies, as AWS would. The root
 * user (the default) may do anything.
 */
export function ActingAs() {
  const identity = useConsoleStore((s) => s.identity);
  const setIdentity = useConsoleStore((s) => s.setIdentity);
  const qc = useQueryClient();
  const { data } = useIdentities();
  const isRoot = identity === "root";

  const choose = async (next: string) => {
    if (next === identity) return;
    try {
      // Ask the server first: a role must trust this account, and the user must still exist.
      if (next !== "root") await api.whoami(next);
      setIdentity(next);
      await qc.resetQueries();
      toast.success(next === "root" ? "Back to the root user" : `Now acting as ${next}`, {
        description: next === "root" ? "You can do anything again." : "Everything you do is checked against its policies.",
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.code : "Couldn't switch", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Select value={identity} onValueChange={choose}>
      <SelectTrigger
        className={cn("h-8 w-auto max-w-44 gap-1.5 sm:max-w-56", !isRoot && "border-warning bg-warning/10 font-medium")}
        aria-label="Acting as"
        title="The IAM identity the console and terminal use"
      >
        {isRoot ? <ShieldIcon className="size-4 shrink-0" /> : identity.startsWith("role/") ? <UserRoundCogIcon className="size-4 shrink-0" /> : <UserIcon className="size-4 shrink-0" />}
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="root">Root user</SelectItem>
        {/* Keep the current choice selectable even before the lists load. */}
        {!isRoot && !data && <SelectItem value={identity}>{identity}</SelectItem>}
        {!!data?.users.length && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>IAM users</SelectLabel>
              {data.users.map((u) => (
                <SelectItem key={u.id} value={`user/${u.name}`}>
                  user/{u.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
        {!!data?.roles.length && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Switch role</SelectLabel>
              {data.roles.map((r) => (
                <SelectItem key={r.id} value={`role/${r.name}`}>
                  role/{r.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
        {data && !data.users.length && !data.roles.length && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Create IAM users or roles to act as them.</p>
        )}
      </SelectContent>
    </Select>
  );
}
