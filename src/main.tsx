import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createCircusApi, type CircusApi } from './api/client';
import type { ListResponse } from './api/types';
import type { MemoryApi } from './dev/memoryApi';
import { createShortcutRegistry } from './shortcuts/contexts';
import { installKeyboardHost } from './shortcuts/keyboard-host';
import { ShortcutRegistryProvider } from './shortcuts/react';
import './index.css';

declare global {
  interface Window {
    circusFake?: MemoryApi;
  }
}

async function createApi(): Promise<CircusApi> {
  if (import.meta.env.VITE_FAKE_API !== '1') return createCircusApi();
  const [{ createMemoryApi }, { syntheticRows }, golden] = await Promise.all([
    import('./dev/memoryApi'),
    import('./dev/synthetic'),
    import('./test/golden/contract-list.json'),
  ]);
  const env = import.meta.env;
  const seed: ListResponse = {
    ...(golden.default as unknown as ListResponse),
    sessions: syntheticRows(Number(env.VITE_FAKE_ROWS ?? 2000), Date.now()),
  };
  const fake = createMemoryApi(seed, {
    latencyMs: Number(env.VITE_FAKE_LATENCY_MS ?? 150),
    cache: env.VITE_FAKE_CACHE !== '0',
  });
  window.circusFake = fake;
  return fake;
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

const [registry, api] = await Promise.all([createShortcutRegistry(), createApi()]);
installKeyboardHost(registry, window);

createRoot(root).render(
  <StrictMode>
    <ShortcutRegistryProvider registry={registry}>
      <App api={api} />
    </ShortcutRegistryProvider>
  </StrictMode>,
);
