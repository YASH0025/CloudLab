import type { ResourceTypeDef } from "../types";

/**
 * A learner's progress (tutorial steps, challenge results), kept with their
 * lab so it follows them across devices and into their account when they
 * sign in. Not an AWS resource: hidden from the console and the CLI.
 */
export const progressType: ResourceTypeDef = {
  service: "guide",
  type: "progress",
  label: "Progress",
  pluralLabel: "Progress",
  description: "Your Nuvora learning progress.",
  idPrefix: "progress",
  global: true,
  hidden: true,
  notFoundCode: "NotFound",
  apiNoun: "progress",
  fields: [],
  columns: [],
};
