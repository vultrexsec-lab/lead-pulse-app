/** @type {import('next').NextConfig} */
const BACKEND = (
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://lead-pulse-app-etcf.onrender.com"
).replace(/\/$/, "");

const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND}/api/:path*`,
      },
      {
        source: "/qr",
        destination: `${BACKEND}/qr`,
      },
    ];
  },
};

export default nextConfig;
