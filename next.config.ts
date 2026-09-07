import type { NextConfig } from "next";

function backendOrigin() {
  const configured = process.env.BACKEND_URL?.trim() || "http://127.0.0.1:4000";
  const url = new URL(configured);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("BACKEND_URL must be an HTTP(S) origin without credentials or a query.");
  }

  return url.toString().replace(/\/$/, "");
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    // Generation submission may take 60 seconds and FFmpeg renders may take five minutes.
    proxyTimeout: 360_000,
    // The backend accepts up to 40 MiB of music plus multipart framing.
    proxyClientMaxBodySize: "48mb",
  },
  output: "standalone",
  poweredByHeader: false,
  async rewrites() {
    const origin = backendOrigin();

    return [
      { source: "/api/:path*", destination: `${origin}/api/:path*` },
      { source: "/media/:path*", destination: `${origin}/media/:path*` },
    ];
  },
};

export default nextConfig;
