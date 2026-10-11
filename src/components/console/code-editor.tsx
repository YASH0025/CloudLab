"use client";

import { FilePlusIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A small editor for a function's files: tabs per file, a monospace text area
 * where Tab indents, and adding or removing files. Enough for learning-sized
 * functions; real projects upload a .zip from the CLI.
 */
export function CodeEditor({
  value,
  onChange,
  disabled,
  id,
  invalid,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
}) {
  const names = useMemo(
    () => Object.keys(value).sort((a, b) => (a.startsWith("index.") ? -1 : b.startsWith("index.") ? 1 : a.localeCompare(b))),
    [value],
  );
  const [active, setActive] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const current = active && active in value ? active : names[0];
  const text = current ? value[current] : "";
  const lines = text.split("\n").length;

  const add = () => {
    const name = newName.trim();
    if (!/^[\w.\-/]{1,200}$/.test(name) || name in value) return;
    onChange({ ...value, [name]: "" });
    setActive(name);
    setAdding(false);
    setNewName("");
  };

  return (
    <div className={cn("overflow-hidden rounded-md border", invalid && "border-destructive")}>
      <div className="flex flex-wrap items-center gap-1 border-b bg-muted/50 px-1.5 py-1">
        {names.map((n) => (
          <span
            key={n}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-1 font-mono text-xs",
              n === current ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <button type="button" onClick={() => setActive(n)}>
              {n}
            </button>
            {!disabled && names.length > 1 && (
              <button
                type="button"
                aria-label={`Remove ${n}`}
                className="opacity-60 hover:opacity-100"
                onClick={() => {
                  const next = { ...value };
                  delete next[n];
                  onChange(next);
                }}
              >
                <XIcon className="size-3" />
              </button>
            )}
          </span>
        ))}
        {!disabled &&
          (adding ? (
            <span className="flex items-center gap-1">
              <Input
                autoFocus
                value={newName}
                placeholder="lib/util.mjs"
                className="h-7 w-40 font-mono text-xs"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                  if (e.key === "Escape") setAdding(false);
                }}
              />
              <Button type="button" size="sm" variant="ghost" className="h-7" onClick={add}>
                Add
              </Button>
            </span>
          ) : (
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding(true)}>
              <FilePlusIcon className="size-3.5" /> File
            </Button>
          ))}
      </div>
      <div className="flex max-h-[28rem] overflow-auto bg-background">
        <pre aria-hidden className="select-none border-r bg-muted/30 px-2 py-2 text-right font-mono text-xs leading-5 text-muted-foreground">
          {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
        </pre>
        <textarea
          ref={area}
          id={id}
          aria-label={current ? `Code: ${current}` : "Code"}
          spellCheck={false}
          wrap="off"
          disabled={disabled || !current}
          value={text}
          rows={Math.max(12, lines + 1)}
          className="min-w-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-xs leading-5 outline-none disabled:opacity-70"
          onChange={(e) => current && onChange({ ...value, [current]: e.target.value })}
          onKeyDown={(e) => {
            // Tab indents instead of leaving the editor.
            if (e.key !== "Tab" || !current) return;
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: s, selectionEnd: end } = el;
            const next = text.slice(0, s) + "  " + text.slice(end);
            onChange({ ...value, [current]: next });
            requestAnimationFrame(() => {
              el.selectionStart = el.selectionEnd = s + 2;
            });
          }}
        />
      </div>
    </div>
  );
}
