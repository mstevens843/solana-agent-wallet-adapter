import { defineConfig } from 'vite';

const capacitorIosApp =
  process.env.VITE_CAPACITOR_IOS_APP ??
  process.env.VITE_CAPACITATOR_IOS_APP ??
  process.env.CAPACITOR_IOS_APP ??
  process.env.CAPACITATOR_IOS_APP ??
  'true';

export default defineConfig({
  define: {
    'import.meta.env.VITE_CAPACITOR_IOS_APP': JSON.stringify(capacitorIosApp),
    'import.meta.env.VITE_CAPACITATOR_IOS_APP': JSON.stringify(capacitorIosApp),
  },
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
