import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Browser trace HTML is an output, never an application entry or CSS source.
  server: { watch: { ignored: ['**/artifacts/**', '**/test-results/**', '**/playwright-report/**', '**/.cache/**'] } },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
