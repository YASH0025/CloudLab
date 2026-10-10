import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Static websites (/website/<bucket>/docs/) need the trailing slash: on S3 it means "folder".
  skipTrailingSlashRedirect: true,
  // Sample files for tutorials download with their real names (index.html), instead of
  // opening in the browser, where "Save as" would name them after the page title.
  async headers() {
    return [{ source: "/samples/:path*", headers: [{ key: "Content-Disposition", value: "attachment" }] }];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
