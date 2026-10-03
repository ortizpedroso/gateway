import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * SPA ultraleve do checkout white-label. Em produção é servida via CDN em
 * /pay/{slug}; fala apenas com a API pública da plataforma (/api/v1/public/*)
 * usando a publishable key (pk_live_...) — nunca expõe a upstream provider.
 */
export default defineConfig({
  plugins: [react()],
  base: "/checkout/",
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: { entryFileNames: "assets/index.js", chunkFileNames: "assets/[name].js" },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
});
