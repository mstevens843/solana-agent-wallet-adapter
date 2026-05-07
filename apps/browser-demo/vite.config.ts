import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('@solana/web3.js') ||
            id.includes('@noble') ||
            id.includes('bn.js') ||
            id.includes('borsh')
          ) {
            return 'solana-runtime';
          }
          if (id.includes('@solana-mobile') || id.includes('mwa-mobile-web')) {
            return 'mobile-wallet-adapter';
          }
          if (id.includes('@wallet-standard') || id.includes('wallet-standard')) {
            return 'wallet-standard';
          }
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
  },
});
