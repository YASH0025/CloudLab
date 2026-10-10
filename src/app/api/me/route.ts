import { connection } from "next/server";
import { enabledProviders, getSignedInUser } from "@/server/auth";
import { handle } from "@/server/api";

/** Who's signed in, and which sign-in options this site offers. */
export async function GET() {
  return handle(async () => {
    // Depends on the visitor's session, so it must run per request, never be prerendered.
    await connection();
    const providers = enabledProviders();
    const user = providers.length > 0 ? await getSignedInUser() : null;
    return Response.json({
      providers,
      user: user ? { name: user.name, email: user.email, image: user.image ?? null } : null,
    });
  });
}
