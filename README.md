# CloudLab

A hands-on cloud and DevOps practice platform. Learners build networks, launch servers and create storage in a simulated cloud that follows the same rules, workflows and error codes as the real thing, without any cloud bill.

Nothing here provisions real infrastructure. Every resource is a record in a database, and a rules engine decides what is valid, what depends on what, and how resources move between states.

## What works today

| Service | Modelled on | Resource types |
| --- | --- | --- |
| Virtual Network | VPC | VPCs, subnets, internet gateways, route tables, security groups |
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

### Reachability check

Every instance page has a **reachability check**: pick HTTP, HTTPS, SSH, ping or any protocol/port/source, and CloudLab walks the same chain a real network would (instance state → public IP → subnet route table → route → internet gateway → security group rules). Each link passes or fails with an explanation and, when it fails, the exact fix. Network ACLs are not simulated yet.

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

### Using Neon

1. Create a free project at neon.tech and copy its connection string.
2. `cp .env.example .env` and paste it as `DATABASE_URL`.
3. Create the table: `npm run db:push`
4. `npm run dev`

### Deploying to Vercel

1. Import the repo in Vercel.
2. Add `DATABASE_URL` under Project → Settings → Environment Variables.
3. Run `npm run db:push` once against that database (locally with the same `DATABASE_URL`).

An in-memory store is not shared between serverless instances, so a database is required in deployment.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate route types and run TypeScript |
| `npm test` | Engine tests |
| `npm run db:push` | Sync the Drizzle schema to the database |
| `npm run db:generate` / `db:migrate` | Generate and apply SQL migrations |
| `npm run db:studio` | Browse the database |

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/services?region=` | – |
| GET | `/api/resources?service=&type=&region=` | – |
| POST | `/api/resources` | `{ service, type, region, config }` |
| GET | `/api/resources/:id` | – (includes `referencedBy`) |
| PATCH | `/api/resources/:id` | `{ config }` |
| DELETE | `/api/resources/:id` | – |
| POST | `/api/resources/:id/actions` | `{ action }` |
| POST | `/api/resources/:id/reachability` | `{ protocol, port?, source? }` |

Errors come back as `{ "error": { "code", "message", "details?" } }`.

---

CloudLab simulates cloud services for learning and is not affiliated with any cloud provider.
