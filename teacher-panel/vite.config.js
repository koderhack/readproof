import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/teacher/",
  build: {
    outDir: "../readproof-site/teacher",
    emptyOutDir: true,
  },
  server: { port: 5175 },
});