"use client";

import { createAuthClient } from "better-auth/react";

/** Browser side of sign-in: starts the GitHub/Google redirect and signs out. */
export const authClient = createAuthClient();
