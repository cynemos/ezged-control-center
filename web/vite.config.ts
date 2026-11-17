import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Chemins relatifs à la balise <base> : l'interface fonctionne à la racine ou sous un préfixe.
  base: './',
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
