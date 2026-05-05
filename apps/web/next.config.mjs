/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@migrator/shared', '@migrator/cost-estimator'],
  typedRoutes: false,
  reactStrictMode: true,
  /**
   * When INTERNAL_API_URL is set (Docker), the browser uses same-origin paths under
   * `/migrator-api/*` (see NEXT_PUBLIC_API_URL) and Next proxies to the Fastify API.
   * That avoids shipping a bundle that always calls http://localhost:4000 from the
   * visitor's machine (wrong host) and avoids cross-origin preflight for simple flows.
   */
  async rewrites() {
    const target = process.env.INTERNAL_API_URL?.trim();
    if (!target) return [];
    const base = target.replace(/\/$/, '');
    return [{ source: '/migrator-api/:path*', destination: `${base}/:path*` }];
  },
};
export default nextConfig;
