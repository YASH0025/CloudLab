"use client";

import { useQueryClient } from "@tanstack/react-query";
import { LogInIcon, LogOutIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMe } from "@/hooks/use-cloud";
import { authClient } from "@/lib/auth-client";
import { useGuideStore } from "@/stores/guide-store";

/** Top-bar sign-in button, or the signed-in user's menu. Hidden when sign-in isn't set up. */
export function UserMenu() {
  const { data } = useMe();
  const queryClient = useQueryClient();
  const router = useRouter();
  if (!data || data.providers.length === 0) return null;

  if (!data.user) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link href="/sign-in">
          <LogInIcon /> <span className="hidden sm:inline">Sign in</span>
        </Link>
      </Button>
    );
  }

  const { user } = data;
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();

  const signOut = async () => {
    await authClient.signOut();
    // Back to an anonymous lab: drop everything cached for the signed-in account.
    useGuideStore.setState({ progress: {}, activeTutorial: null, lastError: null });
    queryClient.clear();
    router.push("/console");
    router.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Account: ${user.email}`} className="rounded-full">
          {user.image ? (
            // eslint-disable-next-line @next/next/no-img-element -- small avatar from GitHub/Google
            <img src={user.image} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" />
          ) : (
            <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {initial}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="space-y-0.5">
          <span className="block truncate text-sm font-medium text-foreground">{user.name}</span>
          <span className="block truncate">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOutIcon /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
