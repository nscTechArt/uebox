/**
 * 公共工具函数
 */

/**
 * OSS上传模拟函数
 * 模拟将本地图片上传到OSS，返回固定的URL
 * @param imagePath 本地图片路径
 * @returns Promise<string> 上传后的URL
 */
export async function uploadImageToOSS(_imagePath: string): Promise<string> {
  // 模拟上传延迟
  await new Promise((resolve) => setTimeout(resolve, 500))

  // 模拟返回固定的URL
  return 'https://wx-mian.cn-sy1.rains3.com/%E5%BE%AE%E4%BF%A1%E6%88%AA%E5%9B%BE_20250919225352.png'
}

/**
 * 批量上传图片到OSS
 * @param imagePaths 本地图片路径数组
 * @returns Promise<string[]> 上传后的URL数组
 */
export async function uploadImagesToOSS(imagePaths: string[]): Promise<string[]> {
  const uploadPromises = imagePaths.map((path) => uploadImageToOSS(path))
  return Promise.all(uploadPromises)
}

/**
 * 解包 IPC/预加载层返回的统一结果对象
 * 当 `success` 为 true 时返回其 `data` 字段；否则抛出错误信息
 * @param res 主进程/预加载层返回的结果对象 `{ success, data, error? }`
 * @param defaultError 当无 `error` 字段时使用的默认错误提示
 * @returns 泛型 `T`，即结果对象中的 `data` 字段
 */
export function unwrapResult<T>(
  res: { success: boolean; data: T; error?: string },
  defaultError: string = '操作失败'
): T {
  if (!res || res.success !== true) {
    throw new Error(res?.error || defaultError)
  }
  return res.data
}

/**
 * 格式化下载速度（字节/秒 -> 人类可读）
 */
export function formatSpeed(bps: number): string {
  if (!bps || bps <= 0) return '0 B/s'
  const k = 1024
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bps) / Math.log(k)))
  const value = bps / Math.pow(k, i)
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`
}

export function generateRandomUsername(prefix: string = 'UE_AGENT_'): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const length = 10
  let result = ''
  if (typeof crypto !== 'undefined' && typeof (crypto as any).getRandomValues === 'function') {
    const arr = new Uint32Array(length)
    ;(crypto as any).getRandomValues(arr)
    for (let i = 0; i < length; i++) {
      result += chars[arr[i] % chars.length]
    }
  } else {
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)]
    }
  }
  return `${prefix}${result}`
}

/**
 * 以固定并发度执行任务列表
 */
export async function runWithConcurrency<T>(
  producers: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = []
  let index = 0
  const workers: Promise<void>[] = []

  const runNext = async () => {
    while (index < producers.length) {
      const current = index++
      const p = producers[current]()
      results[current] = await p
    }
  }

  const size = Math.max(1, Math.min(concurrency, producers.length))
  for (let i = 0; i < size; i++) {
    workers.push(runNext())
  }
  await Promise.all(workers)
  return results
}
