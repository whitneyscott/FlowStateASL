/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MODE_PASSWORD?: string;
  readonly VITE_APP_MODE_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __MODE_PASSWORD__: string;
declare const __WEB_BUILD_SHA__: string;
