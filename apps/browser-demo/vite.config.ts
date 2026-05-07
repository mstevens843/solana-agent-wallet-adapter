import { defineConfig } from 'vite';

const capacitorIosApp =
  process.env.VITE_CAPACITOR_IOS_APP ??
  process.env.VITE_CAPACITATOR_IOS_APP ??
  process.env.CAPACITOR_IOS_APP ??
  process.env.CAPACITATOR_IOS_APP ??
  'true';
const androidApp = process.env.VITE_AGENTIC_ANDROID_APP ?? process.env.AGENTIC_ANDROID_APP ?? 'false';
const androidShowExampleTab =
  process.env.VITE_AGENTIC_ANDROID_SHOW_EXAMPLE_TAB ??
  process.env.AGENTIC_ANDROID_SHOW_EXAMPLE_TAB ??
  'false';

export default defineConfig({
  define: {
    'import.meta.env.VITE_CAPACITOR_IOS_APP': JSON.stringify(capacitorIosApp),
    'import.meta.env.VITE_CAPACITATOR_IOS_APP': JSON.stringify(capacitorIosApp),
    'import.meta.env.VITE_AGENTIC_ANDROID_APP': JSON.stringify(androidApp),
    'import.meta.env.VITE_AGENTIC_ANDROID_SHOW_EXAMPLE_TAB': JSON.stringify(androidShowExampleTab),
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
