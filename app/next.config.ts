import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  basePath: process.env.AIEAS_BASE_PATH || '',
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || '.next',
  serverExternalPackages: ['@rhwp/core', 'word-extractor'],
};

export default nextConfig;
