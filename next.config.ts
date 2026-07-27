import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Include push scripts in the push-approved route's serverless bundle.
  // Scripts run as child processes (not imported); tracing ensures they
  // are available in the Vercel function package alongside the route.
  outputFileTracingIncludes: {
    '/api/push-approved': ['./scripts/*.mjs'],
  },
};

export default nextConfig;
