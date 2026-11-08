import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@inbetween/shared', '@inbetween/adapters', '@inbetween/adapter-youtube'],
  serverExternalPackages: ['pino', 'pino-pretty', 'ioredis', '@grpc/grpc-js', '@grpc/proto-loader'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
