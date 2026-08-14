import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'Elemental-Pull';

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  base: process.env.GITHUB_ACTIONS ? `/${repoName}/` : '/',
  build: {
    outDir: 'dist',
  },
}));
