// Frontend build.
//   npm start      → Node server runs Vite in middleware mode; the app talks to /api over HTTP.
//   npm run build  → dist/kaiku-preview.html: one self-contained file; the backend core runs in
//                    the browser (offline transport, demo data, rules only).
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The standalone build is one file named kaiku-preview.html (Vite would call it index.html).
const renameHtml = (): Plugin => ({
  name: 'kaiku-rename-html',
  enforce: 'post',
  generateBundle(_, bundle) {
    const html = bundle['index.html'];
    if (html) { html.fileName = 'kaiku-preview.html'; }
  }
});

export default defineConfig(({ mode }) => {
  const standalone = mode === 'standalone';
  return {
    root: here('./frontend'),
    plugins: [
      react(),
      ...(standalone ? [viteSingleFile(), {
        // The standalone build is one file people open by double-click: dist/kaiku-preview.html.
        name: 'kaiku-standalone-name',
        enforce: 'post' as const,
        generateBundle(_: unknown, bundle: Record<string, { fileName: string }>) {
          const html = bundle['index.html'];
          if (html) { html.fileName = 'kaiku-preview.html'; }
        }
      }] : [])
    ],
    resolve: {
      alias: {
        '@transport': here(standalone ? './frontend/src/models/transport/offline.ts' : './frontend/src/models/transport/http.ts')
      }
    },
    build: {
      outDir: here('./dist'),
      emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: 'kaiku-preview.js' } }
    }
  };
});
