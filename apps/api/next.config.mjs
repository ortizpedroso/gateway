/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // White-label: nenhuma header expõe upstream (Asaas). URLs sanitizadas na camada de serviço.
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "X-Powered-By", value: "PayHub" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};
export default nextConfig;
