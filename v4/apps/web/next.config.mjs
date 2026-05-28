/** @type {import('next').NextConfig} */
const nextConfig = {
  // output: "standalone",  // desligado — usando pnpm start (single-stage Dockerfile)
  reactStrictMode: true,
  experimental: {
    serverActions: { allowedOrigins: ["localhost:3000", "controler-v4.net.br"] }
  },
  async rewrites() {
    const apiUrl = process.env.API_INTERNAL_URL || "http://localhost:4000";
    return [
      { source: "/api/v1/:path*", destination: `${apiUrl}/:path*` }
    ];
  }
};
export default nextConfig;
