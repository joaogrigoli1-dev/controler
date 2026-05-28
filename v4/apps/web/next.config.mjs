/** @type {import('next').NextConfig} */
const nextConfig = {
  // output: "standalone",  // desligado — usando pnpm start (single-stage Dockerfile)
  reactStrictMode: true,
  experimental: {
    serverActions: { allowedOrigins: ["localhost:3000", "v4.controler.net.br", "controler-v4.net.br"] }
  },
  async rewrites() {
    // No container Docker, o service NestJS é alcançável em http://api:4000
    // Em dev local fora do compose, override com API_INTERNAL_URL=http://localhost:4000
    const apiUrl = process.env.API_INTERNAL_URL || "http://api:4000";
    return {
      beforeFiles: [
        // /be/ = backend NestJS (prefixo /api do Nest é mantido)
        { source: "/be/:path*", destination: `${apiUrl}/api/:path*` },
        { source: "/be-health", destination: `${apiUrl}/health` }
      ],
      afterFiles: [],
      fallback: []
    };
  }
};
export default nextConfig;
