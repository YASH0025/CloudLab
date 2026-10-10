# CloudLab

A hands-on cloud and DevOps practice platform. Learners build networks, launch servers and create storage in a simulated cloud that follows the same rules, workflows and error codes as the real thing, without any cloud bill.

Nothing here provisions real infrastructure. Every resource is a record in a database, and a rules engine decides what is valid, what depends on what, and how resources move between states.

## What works today

| Service | Modelled on | Resource types |
| --- | --- | --- |
| Virtual Network | VPC | VPCs (incl. default VPCs), subnets, internet gateways, route tables (incl. main tables), security groups (incl. default groups and group-to-group rules) |
| Compute | EC2 | Instances (launch, stop, start, reboot, terminate) |
| Object Storage | S3 | Buckets |

Rules that are enforced, each with a real-style error code:

- CIDR blocks must be valid network addresses within the allowed size (`/16`–`/28`); `10.0.0.5/16` is rejected with a suggestion.
- Subnets must sit inside their VPC (`InvalidSubnet.Range`) and must not overlap (`InvalidSubnet.Conflict`).
- A VPC with subnets or security groups cannot be deleted (`DependencyViolation`).
- Instances get a private IP from their subnet (first four addresses reserved) and an optional public IP.
- Security groups must belong to the same VPC as the instance's subnet.
- Instance type can only change while stopped; only terminated instances can be removed (`IncorrectState`).
- Bucket names follow the real naming rules and are unique across all accounts (`BucketAlreadyExists` / `BucketAlreadyOwnedByYou`).
- Versioning can be suspended but never turned back to disabled.
- One internet gateway per VPC; it must be detached before moving, and can't be detached while instances in the VPC have public IPs.
- Route table routes must point at a gateway attached to the same VPC and can't overlap the implicit local route; a subnet uses at most one route table.

### Guide me

A **Guide me** button in the console's top bar opens a guide panel with two tabs.

**Tutorials** walk beginners through a whole journey from the first click to the last, one step at a time: why the step matters, what to do, a "Take me there" link to a pre-filled form, and the CLI equivalent. Each step ticks itself off when the learner's real resources satisfy it, and progress is saved. Steps complete in order, so tutorials can include "break it, then fix it" steps. Current tutorials:

1. **Your first private network**: VPC, subnets in two zones, auto-assigned public IPs
2. **Launch your first web server**: VPC, public subnet, internet gateway, route table, security group, instance, reachability
3. **Why can't I reach my server?**: break the route and the firewall on purpose and fix them using the reachability check

Tutorials are data in `src/guide/tutorials.ts`; adding one means adding an entry with steps and checks.

**Next step** is for anyone stuck at any point, inside a tutorial or not. It reads what the learner has built in the current region and suggests the single most useful next step, from "create a VPC" through to fixing exactly why a server isn't reachable, then intermediate and advanced ideas (lock SSH to your IP, private subnets, resizing, multi-AZ, break-and-fix).

Each suggestion explains **why** it matters, lists the steps, links to the right form **pre-filled with sensible values**, and offers the same thing as a **CLI command** that opens in the terminal. It refreshes as resources change and tracks progress milestones. The panel also explains the user's **last error** in plain language (e.g. what `DependencyViolation` means and how to fix it). Advisor rules live in `src/guide/advisor.ts`; error explanations in `src/guide/errors.ts`.

### Terminal

The console has an in-browser terminal (xterm.js) that runs a simulated AWS CLI against the same resources the console shows. Output is shaped like the real CLI's JSON, and errors read like the real thing, e.g. `An error occurred (DependencyViolation) when calling the DeleteVpc operation: …`. Exit codes follow the CLI (252 usage error, 254 service error). Tab completes services, operations and options; ↑/↓ browse history.

Supported commands:

- `aws ec2`: create/describe/delete VPCs and subnets, `create-default-vpc`, `modify-subnet-attribute`, internet gateways (create, attach, detach, describe, delete), route tables (create, `create-route`, `delete-route`, associate, disassociate, describe, delete), security groups (create, authorize/revoke ingress with `--cidr` or `--source-group`, describe, delete), instances (`run-instances`, describe, start, stop, reboot, terminate, `modify-instance-attribute`), `describe-regions`, `describe-availability-zones`
- `aws s3`: `mb`, `rb`, `ls`
- `aws s3api`: `create-bucket`, `list-buckets`, `delete-bucket`, `put-bucket-versioning`, `get-bucket-versioning`
- `aws sts get-caller-identity`
- Global `--region`, `--filters` (vpc-id, subnet-id, instance-state-name, availability-zone, tag:Name, group-name, isDefault, default-for-az, association.main, attachment.vpc-id) and `--tag-specifications` for Name tags

### Reachability check

Every instance page has a **reachability check**: pick HTTP, HTTPS, SSH, ping or any protocol/port/source, and CloudLab walks the same chain a real network would (instance state → public IP → subnet route table → route → internet gateway → security group rules). Each link passes or fails with an explanation and, when it fails, the exact fix. Network ACLs are not simulated yet.

## Default VPCs, like a real account

The first time an account uses a region, it gets a **default VPC** just like a new AWS account: `172.31.0.0/16`, a `/20` default subnet in every availability zone with public IPs on, an attached internet gateway, and a `0.0.0.0/0` route in the main route table. `aws ec2 run-instances --image-id …` works with no subnet or security group, exactly as in AWS. Deleting the default VPC is allowed, and `aws ec2 create-default-vpc` brings it back.

Every VPC also gets a **main route table** and a **`default` security group** (members can reach each other; all outbound allowed). Subnets without an explicit association use the main route table, and the reachability check follows that. Both are protected (`DependencyViolation`, `CannotDelete`) and are deleted together with their VPC. Security group rules can use **another security group as the source** (`--source-group sg-…`), which blocks deleting the referenced group while in use.

**Reset this region** on the dashboard deletes everything in the region, recreates the default VPC and restarts tutorial progress.

## Errors match AWS

Error codes, messages and behaviour follow the real APIs, checked against AWS's EC2 error-code reference and API docs:

- Validation uses the API's codes: `MissingParameter: The request must contain the parameter groupDescription`, `InvalidParameterValue: Value (x) for parameter availabilityZone is invalid. Subnets can currently only be created in the following availability zones: …`, `InvalidVpc.Range` / `InvalidSubnet.Range: The CIDR '10.0.0.0/8' is invalid.`
- IDs are checked for format first (`InvalidVpcID.Malformed: Invalid id: "vpc-nope" (expecting "vpc-...")`), then existence (`InvalidVpcID.NotFound: The vpc ID 'vpc-…' does not exist`). Resources in another region count as not found.
- `DependencyViolation: The vpc 'vpc-…' has dependencies and cannot be deleted.`, `IncorrectInstanceState: The instance 'i-…' is not in a state from which it can be stopped.`, `RouteAlreadyExists`, `Resource.AlreadyAssociated`, `Gateway.NotAttached`, `InvalidAMIID.NotFound`, S3's `BucketAlreadyExists`, `NoSuchBucket`, `InvalidBucketName`, `MalformedXML`, …
- Behaviour too: VPC and subnet CIDRs are canonicalized (`10.0.0.5/16` becomes `10.0.0.0/16`), stopping a stopped instance is a no-op, deleting a subnet removes its route table association, and an attached internet gateway can't be deleted.
- The terminal prints `An error occurred (Code) when calling the Operation operation: message`, uses the CLI's usage-error layout and `Unknown options: --x`, supports `--dry-run`, and uses its exit codes (252 usage, 254 service error).
- HTTP status follows the service: EC2 errors are 400; S3 uses 404 for `NoSuchBucket` and 409 for name conflicts.

The console form still shows a friendly message on the field that caused the error, and the Guide explains any error in plain language.

## Stack

- **Next.js** (App Router) for the UI and API route handlers
- **TanStack Query** for data fetching, caching, mutations and live polling of resource state
- **TanStack Table** for resource lists (sorting, filtering)
- **React Hook Form + Zod** for forms; the same Zod schemas validate the API
- **shadcn/ui-style components** on **Radix UI**, styled with **Tailwind CSS**
- **Zustand** for console state (selected region), **React Context** for app-wide providers
- **Sonner** toasts, **lucide-react** icons, **date-fns**, **next-themes** (light/dark)
- **Drizzle ORM + Neon** (serverless Postgres)
- **Vitest** for engine tests

## How it works

```
src/
  engine/             The generic resource engine (no React, no database)
    types.ts          Field, lifecycle and service definition types
    engine.ts         Create / read / update / delete / actions / dependency checks
    analysis/         Cross-resource checks such as reachability
    fields.ts         Builds Zod schemas from field definitions (shared by form + API)
    lifecycle.ts      Timestamp-based state transitions
    cidr.ts           IPv4 / CIDR maths
    catalog.ts        Regions, availability zones, images, instance types
    registry.ts       The list of services
    services/         Service definitions: networking, routing, compute, storage
  cli/                Simulated AWS CLI: tokenizer, parser, commands, output shapes, completion
  guide/              Tutorials, "next step" advisor rules, progress and error explanations
  db/                 Drizzle schema and the Postgres store
  server/api.ts       Engine instance, anonymous account cookie, error responses
  app/api/            REST route handlers
  app/console/        Console pages
  components/console/ Schema-driven forms, tables and detail views
  hooks/use-cloud.ts  TanStack Query hooks
```

**Adding a service** is mostly writing a definition file in `src/engine/services/` and adding it to `registry.ts`. The console's sidebar, list pages, create forms, detail pages and API all work from the definition automatically.

**State without background jobs.** Vercel has no long-running processes, so each resource stores the state it is heading towards and when it gets there (`pendingState`, `transitionAt`). Every read settles it if that moment has passed. While anything is mid-transition, the console polls every 1.5 seconds.

**Accounts.** Each browser gets an anonymous lab account via an HTTP-only cookie, so people can start without signing up.

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000. Without `DATABASE_URL`, an in-memory store is used and data resets when the server restarts.

### Using Neon locally

1. Create a free project at neon.tech and copy its connection string.
2. `cp .env.example .env` and paste it as `DATABASE_URL`.
3. `npm run db:migrate` to create the tables, then `npm run dev`.

### Deploying to Vercel

1. In Vercel, **Add New → Project** and import this GitHub repository. Keep the defaults (framework: Next.js).
2. Give it a database, either:
   - **Storage → Neon** in the Vercel project (creates a Neon database and adds `DATABASE_URL` for you), or
   - a Neon project you created yourself: add its connection string as `DATABASE_URL` under **Settings → Environment Variables** (all environments).
3. Deploy (or redeploy after adding the variable). The build runs the database migrations first; the build log shows `✓ Database migrations applied.`
4. Open `https://<your-app>/api/health`. It should say `"store": "postgres", "database": "connected"`.

On Vercel, a missing `DATABASE_URL` fails the build with a clear message instead of silently using the in-memory store, which would lose data between requests.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Apply database migrations (if `DATABASE_URL` is set), then build |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate route types and run TypeScript |
| `npm test` | Engine tests |
| `npm run db:migrate` | Apply SQL migrations from `drizzle/` |
| `npm run db:generate` | Generate a migration after changing `src/db/schema.ts` |
| `npm run db:push` | Sync the schema directly (development only) |
| `npm run db:studio` | Browse the database |

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/health` | – → `{ ok, store, database }` |
| GET | `/api/services?region=` | – |
| GET | `/api/resources?service=&type=&region=` | – |
| POST | `/api/resources` | `{ service, type, region, config }` |
| GET | `/api/resources/:id` | – (includes `referencedBy`) |
| PATCH | `/api/resources/:id` | `{ config }` |
| DELETE | `/api/resources/:id` | – |
| POST | `/api/resources/:id/actions` | `{ action }` |
| POST | `/api/resources/:id/reachability` | `{ protocol, port?, source? }` |
| POST | `/api/lab/reset` | `{ region }` → `{ removed }` |
| GET | `/api/guide/tutorials` | – → `{ tutorials }` |
| GET | `/api/guide/tutorials/:id?region=` | – → `{ tutorial }` with each step's `passes` |
| GET | `/api/guide?region=` | – → `{ advice: { level, next, more, milestones } }` |
| POST | `/api/cli` | `{ command, region }` → `{ output, exitCode, changed }` |

Errors come back as `{ "error": { "code", "message", "details?" } }`.

---

CloudLab simulates cloud services for learning and is not affiliated with any cloud provider.
