import { defineConfig } from 'vite';

// No React plugin: JSX via the built-in transform (tsconfig "jsx": "react-jsx"), full reload on change.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'chrome130' },
});
