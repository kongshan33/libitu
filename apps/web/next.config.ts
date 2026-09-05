import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NODE_ENV === "development" ? ".next" : ".next-build",
  transpilePackages: ["@libitu/core", "@libitu/types"],
};

export default nextConfig;
