import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// A single self-contained HTML file: the explorer works offline, from a file
// or from any static host, with the demo bundle embedded.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { target: "es2022", chunkSizeWarningLimit: 2_000 },
});
