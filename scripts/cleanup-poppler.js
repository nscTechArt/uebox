/**
 * electron-builder afterPack hook (保留，但逻辑已简化)
 *
 * 注意：Poppler 二进制已迁移到 extraResources（不再使用 asarUnpack）
 * 此脚本现在只做日志记录，不再执行清理操作
 *
 * 如需要对打包后的资源做清理，可在此添加逻辑
 */

/**
 * afterPack hook 入口
 * @param {object} context electron-builder context
 */
exports.default = async function (context) {
  const { electronPlatformName } = context

  console.log(`[afterPack] 打包完成 (平台: ${electronPlatformName})`)
  console.log(
    '[afterPack] Poppler 二进制已通过 extraResources 配置直接复制到 resources/poppler-bin'
  )

  // 注意：如果需要为其他平台添加二进制，请在 electron-builder.yml 中配置
  // 目前仅配置了 Windows 平台的 poppler 二进制
}
