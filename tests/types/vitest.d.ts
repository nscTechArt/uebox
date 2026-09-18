/// <reference types="vitest" />
/// <reference types="vite/client" />
/// <reference types="@vue/test-utils" />

import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'
import type { Assertion, AsymmetricMatchersContaining } from 'vitest'

// 扩展 Vitest 的断言类型
declare module 'vitest' {
  interface Assertion<T = any> extends TestingLibraryMatchers<T, void> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers {}
}

// 扩展全局类型
declare global {
  // Electron API 类型
  interface Window {
    electron: {
      ipcRenderer: {
        send: (channel: string, ...args: any[]) => void
        on: (channel: string, listener: (...args: any[]) => void) => void
        removeAllListeners: (channel: string) => void
        invoke: (channel: string, ...args: any[]) => Promise<any>
      }
      process: {
        versions: {
          electron: string
          chrome: string
          node: string
        }
      }
    }
  }

  // 环境变量类型扩展
  interface ImportMetaEnv {
    readonly VITE_APP_ENV: 'development' | 'test' | 'production'
    readonly VITE_APP_BASE_URL: string
    readonly VITE_APP_NAME: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

// Vue 测试工具类型
declare module '@vue/test-utils' {
  interface ComponentMountingOptions<T> {
    // 扩展挂载选项类型
  }
}

// 模块声明
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}

declare module '*.module.less' {
  const classes: { readonly [key: string]: string }
  export default classes
}

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}

declare module '*.jpeg' {
  const src: string
  export default src
}

declare module '*.gif' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.ico' {
  const src: string
  export default src
}

export {}
