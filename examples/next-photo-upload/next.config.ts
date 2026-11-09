import type { NextConfig } from 'next';

const config: NextConfig = {
  // Google API clients are large and Node-only; keep them out of the server bundle.
  serverExternalPackages: ['@googleapis/drive', 'googleapis-common', 'google-auth-library', 'busboy'],
};

export default config;
