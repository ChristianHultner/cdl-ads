import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Include push scripts in the amazon/push-approved route's serverless bundle.
  // Scripts run as child processes (not imported); tracing ensures they
  // are available in the Vercel function package alongside the route.
  outputFileTracingIncludes: {
    '/api/amazon/push-approved': ['./scripts/*.mjs'],
  },

  async redirects() {
    return [
      {
        source:      '/campaigns',
        destination: '/amazon/campaigns',
        permanent:   true,
      },
      {
        source:      '/campaigns/:profileId/:campaignId',
        destination: '/amazon/campaigns/:profileId/:campaignId',
        permanent:   true,
      },
      {
        source:      '/recommendations',
        destination: '/amazon/recommendations',
        permanent:   true,
      },
      {
        source:      '/spend',
        destination: '/amazon/spend',
        permanent:   true,
      },
      {
        source:      '/accounts',
        destination: '/amazon/accounts',
        permanent:   true,
      },
    ]
  },
};

export default nextConfig;
