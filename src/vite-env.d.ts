/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FAKE_API?: string;
  readonly VITE_FAKE_ROWS?: string;
  readonly VITE_FAKE_LATENCY_MS?: string;
  readonly VITE_FAKE_CACHE?: string;
}
