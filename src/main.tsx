import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createShortcutRegistry } from './shortcuts/contexts';
import { installKeyboardHost } from './shortcuts/keyboard-host';
import { ShortcutRegistryProvider } from './shortcuts/react';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

const registry = await createShortcutRegistry();
installKeyboardHost(registry, window);

createRoot(root).render(
  <StrictMode>
    <ShortcutRegistryProvider registry={registry}>
      <App />
    </ShortcutRegistryProvider>
  </StrictMode>,
);
