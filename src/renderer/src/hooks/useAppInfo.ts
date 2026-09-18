import { ref, computed } from 'vue'
import packageJson from '../../../../package.json'

/**
 * 获取应用信息的hook
 * @returns 应用信息对象
 */
export function useAppInfo() {
  // 从package.json获取应用信息
  const appName = ref(packageJson.name)
  const appVersion = ref(packageJson.version)
  const appDescription = ref(packageJson.description)
  const appAuthor = ref(packageJson.author)
  const appHomepage = ref(packageJson.homepage)

  // 格式化的应用名称（首字母大写，去掉连字符）
  const formattedAppName = computed(() => {
    return appName.value
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  })

  // 完整的应用标题
  const appTitle = computed(() => {
    return `${formattedAppName.value} v${appVersion.value}`
  })

  // 应用信息对象
  const appInfo = computed(() => ({
    name: appName.value,
    version: appVersion.value,
    description: appDescription.value,
    author: appAuthor.value,
    homepage: appHomepage.value,
    formattedName: formattedAppName.value,
    title: appTitle.value
  }))

  return {
    // 基础信息
    appName: appName.value,
    appVersion: appVersion.value,
    appDescription: appDescription.value,
    appAuthor: appAuthor.value,
    appHomepage: appHomepage.value,

    // 计算属性
    formattedAppName: formattedAppName.value,
    appTitle: appTitle.value,
    appInfo: appInfo.value
  }
}
