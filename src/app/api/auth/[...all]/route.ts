import { getAuth } from "@/server/auth";

/** better-auth's endpoints (sign-in redirects, OAuth callbacks, sign-out, session). */
function handler(request: Request) {
  const auth = getAuth();
  if (!auth) {
    return Response.json(
      { error: { code: "SignInNotConfigured", message: "Sign-in isn't set up on this site yet." } },
      { status: 404 },
    );
  }
  return auth.handler(request);
}

export const GET = handler;
export const POST = handler;
