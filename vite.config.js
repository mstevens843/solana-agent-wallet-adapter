import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: '/test.html',
  },
  optimizeDeps: {
    include: [
      '@solana-agent-wallet-adapter/core',
      '@solana-agent-wallet-adapter/wallet-standard-web',
      '@wallet-standard/app',
      '@wallet-standard/base',
      '@wallet-standard/features',
      '@solana/wallet-standard-features',
      'bs58',
    ],
  },
});
