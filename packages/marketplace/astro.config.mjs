import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    ssr: {
      // These only execute client-side (React islands).
      // Mark as external so Vite doesn't try to SSR-bundle them.
      external: [
        'three',
        'detect-gpu',
        '@solana/web3.js',
        '@solana/spl-token',
        '@solana/spl-token-group',
        '@solana/wallet-adapter-react',
        '@solana/wallet-adapter-wallets',
        '@solana/wallet-adapter-react-ui',
        '@solana/wallet-adapter-base',
      ],
    },
    optimizeDeps: {
      include: ['detect-gpu'],
    },
    build: {
      chunkSizeWarningLimit: 1000,
    },
  },
});
