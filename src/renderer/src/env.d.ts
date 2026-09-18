/// <reference types="vite/client" />
/// <reference path="../../preload/index.d.ts" />
/// <reference path="./shims-vue.d.ts" />

interface ImportMetaEnv {
  readonly VITE_APP_ENV: 'development' | 'test' | 'production'
  readonly VITE_APP_LOCAL_API_URL?: string

  // 可以添加更多环境变量
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
