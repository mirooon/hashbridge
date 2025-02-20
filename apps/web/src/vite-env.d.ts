/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_ESPLORA_URL?: string;
  readonly VITE_HTLC_PACKAGE_ID?: string;
  readonly VITE_SUI_GRAPHQL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
