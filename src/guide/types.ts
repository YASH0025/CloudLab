/** Shapes shared by the advisor (server) and the guide panel (browser). */

export type Level = "beginner" | "intermediate" | "advanced";

export interface GuideLink {
  service: string;
  type: string;
  mode: "create" | "list" | "detail";
  id?: string;
  /** Values to pre-fill in a create form. */
  prefill?: Record<string, unknown>;
}

export interface Suggestion {
  id: string;
  level: Level;
  title: string;
  /** Why this matters, in plain language. */
  why: string;
  /** What to do, one instruction per step. */
  steps: string[];
  /** Where to do it in the console. */
  link?: GuideLink;
  /** The same thing as a CLI command. */
  cli?: string;
  /** True when there is nothing to do but wait (e.g. an instance is starting). */
  waiting?: boolean;
}

export interface Milestone {
  id: string;
  label: string;
  done: boolean;
}

export interface Advice {
  region: string;
  level: Level;
  next: Suggestion;
  /** A few other worthwhile things to try, after `next`. */
  more: Suggestion[];
  milestones: Milestone[];
}
