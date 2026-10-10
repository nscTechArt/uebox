import { vi } from 'vitest'

/**
 * 挂重型页面（Welcome、ChatWindow 这类 setup 阶段会摸一串 window.api 命名空间、
 * 建一串 ResizeObserver 的组件）时共用的桩。
 */

/**
 * 万能递归 API 桩：任何属性路径都可取、可调用，返回值是它自己，所以「订阅返回
 * 退订函数」这类约定天然成立。
 *
 * 三个特判，每个都是实测踩出来的坑：
 * - `then`/`catch`/`finally` 必须返回 undefined —— 否则 `await` 把它当 thenable，
 *   永远 resolve 不了，测试挂死
 * - `Symbol.iterator` 给空迭代器 —— `for-of` / `for-await` / 展开不炸
 * - `Symbol.toPrimitive` 回 `''` —— vue-i18n 插值 `toDisplayString` 会强转对象，
 *   没有这个会抛 `Cannot convert object to primitive value`
 */
export const universalApiStub: unknown = new Proxy(
  function () {
    /* 代理目标体永不执行，拦截全走 get/apply 两个 trap */
  },
  {
    get: (_target, key) => {
      if (key === 'then' || key === 'catch' || key === 'finally') return undefined
      if (key === Symbol.iterator)
        return function* () {
          /* 空迭代器：for-of / 展开拿到零个元素 */
        }
      if (key === Symbol.toPrimitive) return () => ''
      return universalApiStub
    },
    apply: () => universalApiStub
  }
)

/** 覆盖 tests/setup.ts 里的局部 `window.api`，让组件 setup 随便摸命名空间都不炸 */
export function installWindowApiStub(): void {
  Object.defineProperty(window, 'api', {
    value: universalApiStub,
    configurable: true,
    writable: true
  })
}

/** happy-dom 没有这两个 observer；挂进页面的组件在 onMounted 里直接 new 它们 */
export function installObserverStubs(): void {
  class ObserverStub {
    observe(): void {
      /* 桩：只要方法存在、调用不炸 */
    }
    unobserve(): void {
      /* 桩：只要方法存在、调用不炸 */
    }
    disconnect(): void {
      /* 桩：只要方法存在、调用不炸 */
    }
  }
  vi.stubGlobal('ResizeObserver', ObserverStub)
  vi.stubGlobal('IntersectionObserver', ObserverStub)
}
