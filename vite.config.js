import { defineConfig } from 'vite';
import { resolve } from 'path';

const r = (p) => resolve(import.meta.dirname, p);

export default defineConfig({
  build: {
    outDir: 'static/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'lab-recorder':   r('src/lab/recorder.js'),
        'lab-embed':      r('src/lab/embed.js'),
        'lab-playground':   r('src/lab/playground.js'),
        'lab-activation':   r('src/lab/activation.js'),
        'game':           r('src/game/index.js'),
        'admin-embed':    r('src/admin/embed.js'),
        'admin-tricks':          r('src/admin/tricks.js'),
        'admin-recordings-anim': r('src/admin/recordings-anim.js'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'shared/[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
