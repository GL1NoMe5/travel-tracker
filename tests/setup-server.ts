import { createServer } from 'vite';

// Keep Vite in the runner process: Windows sandboxing can prevent Playwright's
// taskkill-based child-process teardown from finishing after successful tests.
export default async function setupServer() {
  if (process.env.TRAVEL_E2E_BASE_URL) return;
  const url = 'http://127.0.0.1:5173';
  if (!process.env.CI) {
    const running = await fetch(url, { signal: AbortSignal.timeout(750) }).catch(() => null);
    if (running?.ok) return;
  }
  const server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } });
  await server.listen();
  return async () => { await server.close(); };
}
