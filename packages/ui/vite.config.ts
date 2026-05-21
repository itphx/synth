import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5002,
    proxy: {
      '/api': 'http://localhost:5000',
      '/ws': { target: 'http://localhost:5000', ws: true },
      '/auth': 'http://localhost:5000',
    },
  },
});
