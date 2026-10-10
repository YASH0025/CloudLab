import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Static websites (/website/<bucket>/docs/) need the trailing slash: on S3 it means "folder".
  skipTrailingSlashRedirect: true,
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
