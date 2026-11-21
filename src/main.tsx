import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createCircusApi, type CircusApi } from './api/client';
import type { ListResponse, SetupStatus } from './api/types';
import type { MemoryApi } from './dev/memoryApi';
import { createShortcutRegistry } from './shortcuts/contexts';
import { ShortcutKitProvider } from '@shortcutkit/react';
import './index.css';

declare global {
  interface Window {
    circusFake?: MemoryApi;
  }
}

async function createApi(): Promise<CircusApi> {
  if (import.meta.env.VITE_FAKE_API !== '1') return createCircusApi();
  const [{ createMemoryApi }, { keepEvery, snoozeEvery, syntheticRows }, golden] =
    await Promise.all([
      import('./dev/memoryApi'),
      import('./dev/synthetic'),
      import('./test/golden/contract-list.json'),
    ]);
  const env = import.meta.env;
  const nowMs = Date.now();
  const seed: ListResponse = {
    ...(golden.default as unknown as ListResponse),
    ...snoozeEvery(
      keepEvery(syntheticRows(Number(env.VITE_FAKE_ROWS ?? 2000), nowMs), 50, nowMs),
      100,
      nowMs,
    ),
  };
  const fake = createMemoryApi(seed, {
    latencyMs: Number(env.VITE_FAKE_LATENCY_MS ?? 150),
    cache: env.VITE_FAKE_CACHE !== '0',
    ...(env.VITE_FAKE_SETUP === undefined
      ? {}
      : { setup: env.VITE_FAKE_SETUP as SetupStatus['state'], onboarded: false }),
  });
  window.circusFake = fake;
  return fake;
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

const [registry, api] = await Promise.all([createShortcutRegistry(), createApi()]);

createRoot(root).render(
  <StrictMode>
    <ShortcutKitProvider registry={registry}>
      <App api={api} />
    </ShortcutKitProvider>
  </StrictMode>,
);
