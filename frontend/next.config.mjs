/** @type {import('next').NextConfig} */
const BACKEND = (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(
  /\/$/,
  ""
);

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
