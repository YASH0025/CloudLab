"use client";

import {
  columnFilteringFeature,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type HeaderContext,
} from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { ArrowUpDownIcon, MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResolvedTypeDef, ResourceDTO } from "@/engine/types";
import { routes } from "@/lib/routes";
import { cn, formatValue, getPath } from "@/lib/utils";
import { StateBadge } from "./state-badge";

// Registered once at module scope, as TanStack Table v9 expects stable features.
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
});

type Features = typeof features;
type Column = ColumnDef<Features, ResourceDTO>;

function SortHeader({ label, ctx }: { label: string; ctx: HeaderContext<Features, ResourceDTO, unknown> }) {
  const sorted = ctx.column.getIsSorted();
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 hover:text-foreground"
      onClick={() => ctx.column.toggleSorting(sorted === "asc")}
    >
      {label}
      <ArrowUpDownIcon className="size-3" />
    </button>
  );
}

interface ResourceTableProps {
  typeDef: ResolvedTypeDef;
  data: ResourceDTO[];
  onAction: (resource: ResourceDTO, action: string) => void;
  onDelete: (resource: ResourceDTO) => void;
}

export function ResourceTable({ typeDef, data, onAction, onDelete }: ResourceTableProps) {
  const [globalFilter, setGlobalFilter] = useState("");

  const columns = useMemo<Column[]>(() => {
    const cols: Column[] = [
      {
        id: "name",
        accessorFn: (r) => `${r.name} ${r.id}`,
        header: (ctx) => <SortHeader label="Name / ID" ctx={ctx} />,
        cell: ({ row }) => (
          <Link href={routes.detail(row.original.service, row.original.type, row.original.id)} className="group">
            <span className="font-medium text-primary group-hover:underline">{row.original.name || "–"}</span>
            {row.original.name !== row.original.id && (
              <span className="block font-mono text-xs text-muted-foreground">{row.original.id}</span>
            )}
          </Link>
        ),
      },
    ];

    if (typeDef.lifecycle) {
      cols.push({
        id: "state",
        accessorFn: (r) => r.state ?? "",
        header: (ctx) => <SortHeader label="State" ctx={ctx} />,
        cell: ({ row }) => <StateBadge state={row.original.state} pending={row.original.pendingState} />,
      });
    }

    for (const c of typeDef.columns) {
      cols.push({
        id: c.path,
        accessorFn: (r) => formatValue(getPath(r, c.path)),
        header: c.label,
        cell: ({ getValue }) => <span className={cn(c.mono && "font-mono text-xs")}>{String(getValue())}</span>,
      });
    }

    cols.push({
      id: "createdAt",
      accessorFn: (r) => r.createdAt,
      header: (ctx) => <SortHeader label="Created" ctx={ctx} />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
        </span>
      ),
    });

    cols.push({
      id: "actions",
      enableSorting: false,
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const r = row.original;
        const actions = Object.entries(typeDef.lifecycle?.actions ?? {});
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Actions for ${r.id}`}>
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {actions.length > 0 && <DropdownMenuLabel>State</DropdownMenuLabel>}
              {actions.map(([key, a]) => (
                <DropdownMenuItem
                  key={key}
                  variant={a.destructive ? "destructive" : "default"}
                  disabled={!r.state || !a.from.includes(r.state)}
                  onSelect={() => onAction(r, key)}
                >
                  {a.label}
                </DropdownMenuItem>
              ))}
              {actions.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(r)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    });
    return cols;
  }, [typeDef, onAction, onDelete]);

  const table = useTable({
    features,
    columns,
    data,
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    getColumnCanGlobalFilter: (column) => column.id !== "actions" && column.id !== "createdAt",
  });

  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b p-3">
        <Input
          placeholder={`Filter ${typeDef.pluralLabel.toLowerCase()}…`}
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="h-8 max-w-xs"
          aria-label="Filter"
        />
      </div>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="py-10 text-center text-muted-foreground">
                {data.length === 0 ? `No ${typeDef.pluralLabel.toLowerCase()} in this region.` : "No matches."}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
