/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module — keep it out of the bundler.
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
  // Standalone build = self-contained server suitable for a small Docker image.
  output: "standalone",
};

export default nextConfig;
