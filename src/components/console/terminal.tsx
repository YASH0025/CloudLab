"use client";

import "@xterm/xterm/css/xterm.css";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { commonPrefix, complete } from "@/cli/complete";
import type { CliResult } from "@/cli/execute";
import { useConsoleStore } from "@/stores/console-store";
import { useGuideStore } from "@/stores/guide-store";

export interface TerminalHandle {
  /** Replaces the current input line with `text`, ready to run with Enter. */
  insert(text: string): void;
}

const HISTORY_KEY = "cloudlab-cli-history";
const C = { reset: "\x1b[0m", green: "\x1b[32m", cyan: "\x1b[36m", red: "\x1b[31m", dim: "\x1b[2m", bold: "\x1b[1m" };

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveHistory(history: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-200)));
  } catch {
    // Storage can be unavailable (private mode); history then lasts for the session only.
  }
}

async function runCommand(command: string, region: string): Promise<CliResult> {
  const res = await fetch("/api/cli", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, region }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? res.statusText);
  return body as CliResult;
}

/** An in-browser terminal running the simulated CLI. */
export const Terminal = forwardRef<TerminalHandle>(function Terminal(_props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const region = useConsoleStore((s) => s.region);
  const regionRef = useRef(region);
  const queryClient = useQueryClient();
  const exec = useMutation({ mutationFn: ({ command, region }: { command: string; region: string }) => runCommand(command, region) });
  const execRef = useRef(exec.mutateAsync);

  // Line-editor state lives in refs: xterm's event handlers outlive renders.
  const line = useRef("");
  const cursor = useRef(0);
  const busy = useRef(false);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(0);

  useEffect(() => {
    regionRef.current = region;
    execRef.current = exec.mutateAsync;
  });

  const prompt = () => `${C.green}learner@cloudlab${C.reset}:${C.cyan}${regionRef.current}${C.reset}$ `;

  const redraw = () => {
    const term = termRef.current;
    if (!term) return;
    term.write(`\r\x1b[K${prompt()}${line.current}`);
    const back = line.current.length - cursor.current;
    if (back > 0) term.write(`\x1b[${back}D`);
  };

  // A command handed over before xterm finished loading is placed on the prompt once it's ready.
  const pendingInsert = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({
    insert(text: string) {
      if (!termRef.current) {
        pendingInsert.current = text;
        return;
      }
      if (busy.current) return;
      line.current = text;
      cursor.current = text.length;
      redraw();
      termRef.current?.focus();
    },
  }));

  useEffect(() => {
    let disposed = false;
    let fit: FitAddon | null = null;
    let observer: ResizeObserver | null = null;

    (async () => {
      // xterm touches `window`, so it is loaded only in the browser.
      const [{ Terminal: XTermCtor }, { FitAddon: FitCtor }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      // xterm draws on a canvas, which can't resolve CSS variables, so pass the real font name.
      await document.fonts.ready;
      if (disposed || !containerRef.current) return;
      const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim();

      const term = new XTermCtor({
        cursorBlink: true,
        convertEol: true,
        fontFamily: `${mono ? `${mono}, ` : ""}ui-monospace, Menlo, Consolas, monospace`,
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 5000,
        theme: {
          background: "#0d1117",
          foreground: "#d6deeb",
          cursor: "#7fdbca",
          selectionBackground: "#264f78",
          green: "#7fdb8a",
          cyan: "#7fdbca",
          red: "#ff7a85",
        },
      });
      fit = new FitCtor();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();
      termRef.current = term;
      history.current = loadHistory();
      historyIndex.current = history.current.length;

      term.writeln(`${C.bold}CloudLab terminal${C.reset} ${C.dim}— a simulated AWS CLI. Nothing here touches a real account.${C.reset}`);
      term.writeln(`${C.dim}Type 'help' to see supported commands. Tab completes, ↑/↓ browse history.${C.reset}`);
      term.writeln("");
      term.write(prompt());
      if (pendingInsert.current) {
        line.current = pendingInsert.current;
        cursor.current = line.current.length;
        pendingInsert.current = null;
        redraw();
      }

      const submit = async () => {
        const command = line.current.trim();
        term.write("\r\n");
        line.current = "";
        cursor.current = 0;
        if (command) {
          if (history.current[history.current.length - 1] !== command) {
            history.current.push(command);
            saveHistory(history.current);
          }
        }
        historyIndex.current = history.current.length;

        if (command === "clear") {
          term.clear();
        } else if (command) {
          busy.current = true;
          try {
            const result = await execRef.current({ command, region: regionRef.current });
            if (result.output) {
              const color = result.exitCode === 0 ? "" : C.red;
              term.writeln(`${color}${result.output}${color ? C.reset : ""}`);
            }
            if (result.changed) {
              queryClient.invalidateQueries({ queryKey: ["resources"] });
              queryClient.invalidateQueries({ queryKey: ["resource"] });
              queryClient.invalidateQueries({ queryKey: ["guide"] });
            }
            // Let the guide explain service errors such as DependencyViolation.
            const failed = /An error occurred \(([^)]+)\)[^:]*: (.*)/.exec(result.output);
            if (failed) useGuideStore.getState().setLastError({ code: failed[1], message: failed[2] });
          } catch (e) {
            term.writeln(`${C.red}Request failed: ${(e as Error).message}${C.reset}`);
          } finally {
            busy.current = false;
          }
        }
        term.write(prompt());
      };

      const insertText = (text: string) => {
        line.current = line.current.slice(0, cursor.current) + text + line.current.slice(cursor.current);
        cursor.current += text.length;
        redraw();
      };

      term.onData((data) => {
        if (busy.current) return;
        switch (data) {
          case "\r":
            void submit();
            return;
          case "\x7f": // Backspace
            if (cursor.current > 0) {
              line.current = line.current.slice(0, cursor.current - 1) + line.current.slice(cursor.current);
              cursor.current--;
              redraw();
            }
            return;
          case "\x1b[3~": // Delete
            line.current = line.current.slice(0, cursor.current) + line.current.slice(cursor.current + 1);
            redraw();
            return;
          case "\x03": // Ctrl+C
            term.write("^C\r\n");
            line.current = "";
            cursor.current = 0;
            term.write(prompt());
            return;
          case "\x0c": // Ctrl+L
            term.clear();
            redraw();
            return;
          case "\x1b[A": // Up
            if (historyIndex.current > 0) {
              historyIndex.current--;
              line.current = history.current[historyIndex.current];
              cursor.current = line.current.length;
              redraw();
            }
            return;
          case "\x1b[B": // Down
            historyIndex.current = Math.min(history.current.length, historyIndex.current + 1);
            line.current = history.current[historyIndex.current] ?? "";
            cursor.current = line.current.length;
            redraw();
            return;
          case "\x1b[D": // Left
            if (cursor.current > 0) {
              cursor.current--;
              term.write(data);
            }
            return;
          case "\x1b[C": // Right
            if (cursor.current < line.current.length) {
              cursor.current++;
              term.write(data);
            }
            return;
          case "\x1b[H":
          case "\x01": // Home / Ctrl+A
            cursor.current = 0;
            redraw();
            return;
          case "\x1b[F":
          case "\x05": // End / Ctrl+E
            cursor.current = line.current.length;
            redraw();
            return;
          case "\t": {
            const before = line.current.slice(0, cursor.current);
            const { word, candidates } = complete(before);
            if (candidates.length === 1) {
              insertText(candidates[0].slice(word.length) + " ");
            } else if (candidates.length > 1) {
              const prefix = commonPrefix(candidates);
              if (prefix.length > word.length) insertText(prefix.slice(word.length));
              else {
                term.write(`\r\n${candidates.join("  ")}\r\n`);
                redraw();
              }
            }
            return;
          }
        }
        // Printable text, including pastes. A pasted newline runs the first line only.
        if (data.startsWith("\x1b")) return;
        const text = data.split(/\r\n|\r|\n/)[0].replace(/[\x00-\x1f\x7f]/g, "");
        if (text) insertText(text);
        if (/[\r\n]/.test(data)) void submit();
      });

      observer = new ResizeObserver(() => fit?.fit());
      observer.observe(containerRef.current);
      term.focus();
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
    };
    // The terminal is created once; live values are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-full min-h-[420px] overflow-hidden rounded-lg border bg-[#0d1117] p-3">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
});
