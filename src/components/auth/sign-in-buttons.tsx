"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { GitHubMark, GoogleMark } from "./provider-icons";

const LABELS = { github: "Continue with GitHub", google: "Continue with Google" } as const;

/** One button per configured provider. Sends the visitor to GitHub/Google and back to the console. */
export function SignInButtons({ providers }: { providers: ("github" | "google")[] }) {
  const [pending, setPending] = useState<string | null>(null);

  const signIn = async (provider: "github" | "google") => {
    setPending(provider);
    const { error } = await authClient.signIn.social({ provider, callbackURL: "/console" });
    // On success the browser is already on its way to GitHub/Google.
    if (error) {
      setPending(null);
      toast.error("Couldn't start sign-in", { description: error.message ?? "Please try again." });
    }
  };

  return (
    <div className="space-y-2">
      {providers.map((p) => (
        <Button
          key={p}
          variant="outline"
          size="lg"
          className="w-full justify-center"
          disabled={pending !== null}
          onClick={() => signIn(p)}
        >
          {p === "github" ? <GitHubMark className="size-4" /> : <GoogleMark className="size-4" />}
          {pending === p ? "Redirecting…" : LABELS[p]}
        </Button>
      ))}
    </div>
  );
}
