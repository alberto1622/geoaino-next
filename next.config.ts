import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["shapefile", "jszip", "proj4"],
  experimental: {
    serverActions: { bodySizeLimit: "500mb" },
  },
};

export default nextConfig;
