import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    reactStrictMode: true,
    poweredByHeader: false,
    // The E2E suite drives the dev server over 127.0.0.1 while the browser
    // reports a `localhost` origin, which Next.js blocks as cross-origin for
    // safety. Allowing this loopback host keeps the dev HMR channel usable
    // without widening the policy to anything routable.
    allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;