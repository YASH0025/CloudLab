"use client";

import { BoxIcon } from "lucide-react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { site } from "@/config/site";
import { useMe } from "@/hooks/use-cloud";
import { SignInButtons } from "./sign-in-buttons";

export function SignInView() {
  const { data, isLoading } = useMe();

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <Link href="/" className="flex items-center justify-center gap-2 font-semibold">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BoxIcon className="size-4" />
          </span>
          {site.name}
        </Link>
        <Card>
          <CardContent className="space-y-5 py-6">
            <div className="space-y-1 text-center">
              <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
              <p className="text-sm text-muted-foreground">
                Keep your lab and tutorial progress on every device. Anything you&apos;ve already built in this browser
                moves into your account.
              </p>
            </div>
            {isLoading ? (
              <Skeleton className="h-24" />
            ) : data?.user ? (
              <p className="rounded-md bg-muted px-3 py-2 text-center text-sm">
                You&apos;re signed in as <span className="font-medium">{data.user.email}</span>.{" "}
                <Link href="/console" className="text-primary hover:underline">
                  Open the console
                </Link>
              </p>
            ) : data && data.providers.length > 0 ? (
              <SignInButtons providers={data.providers} />
            ) : (
              <p className="rounded-md bg-muted px-3 py-2 text-center text-sm text-muted-foreground">
                Sign-in isn&apos;t set up on this site yet.
              </p>
            )}
            <p className="text-center text-sm">
              <Link href="/console" className="text-muted-foreground hover:text-foreground hover:underline">
                Continue without an account
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
