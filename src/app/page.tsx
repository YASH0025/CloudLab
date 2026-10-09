import { ArrowRightIcon, BoxIcon, DatabaseIcon, NetworkIcon, ServerIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { site } from "@/config/site";

const features = [
  {
    icon: NetworkIcon,
    title: "Real networking rules",
    body: "CIDR ranges, overlapping subnets and cross-VPC mistakes fail exactly the way they do in production.",
  },
  {
    icon: ServerIcon,
    title: "Instances with a lifecycle",
    body: "Launch, stop, start and terminate. Watch servers move through pending, running and stopping.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Errors that teach",
    body: "Every rejection comes with a real-style error code and a plain explanation of what went wrong.",
  },
  {
    icon: DatabaseIcon,
    title: "Storage that behaves",
    body: "Globally unique bucket names, naming rules and versioning that can be suspended but never turned off.",
  },
];

export default function HomePage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2 font-semibold">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BoxIcon className="size-4" />
          </span>
          {site.name}
        </span>
        <Button asChild size="sm">
          <Link href="/console">Open console</Link>
        </Button>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6">
        <section className="py-20 sm:py-28">
          <p className="mb-4 inline-flex rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
            Cloud &amp; DevOps practice · no account · no bill
          </p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">{site.tagline}</h1>
          <p className="mt-6 max-w-2xl text-lg text-muted-foreground">{site.description}</p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/console">
                Start building <ArrowRightIcon />
              </Link>
            </Button>
          </div>
        </section>

        <section className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
          {features.map((f) => (
            <div key={f.title} className="bg-card p-6">
              <f.icon className="size-5 text-primary" />
              <h2 className="mt-4 font-medium">{f.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-10 text-sm text-muted-foreground">
        {site.name} simulates cloud services for learning. It is not affiliated with any cloud provider.
      </footer>
    </div>
  );
}
