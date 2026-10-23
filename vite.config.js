import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    open: "/rts.html",
  },
  build: {
    rollupOptions: {
      input: "rts.html",
    },
  },
});
