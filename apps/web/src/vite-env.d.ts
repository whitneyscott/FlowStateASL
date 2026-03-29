/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_MODE_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
