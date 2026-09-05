import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://localhost:3001/api/:path*" }];
  },
  // /api/ask can legitimately take >30s when the LLM provider is slow or fails over; the default
  // proxy timeout (30s) turned those into a bare "Internal Server Error" in the UI.
  experimental: { proxyTimeout: 180_000 },
};
export default nextConfig;
