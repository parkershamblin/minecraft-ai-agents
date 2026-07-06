import type { NextConfig } from 'next'

// Single-origin via rewrites (no CORS, no BFF yet — dashboard-service takes
// this job over at M1/M2). Host-run services by default; compose overrides.
const AGENT = process.env.AGENT_SERVICE_URL ?? 'http://localhost:8001'
const EVENTS = process.env.EVENT_SERVICE_URL ?? 'http://localhost:8081'

const nextConfig: NextConfig = {
  // gzip buffers the proxied SSE stream for browser clients (curl, which
  // sends no Accept-Encoding, streams fine — the classic invisible bug).
  compress: false,
  async rewrites() {
    return [
      { source: '/api/agent/:path*', destination: `${AGENT}/:path*` },
      { source: '/api/events/:path*', destination: `${EVENTS}/:path*` },
    ]
  },
}

export default nextConfig
