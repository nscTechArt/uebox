import { ipcMain, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import * as nodeFs from 'fs'
import path from 'path'
import { app } from 'electron'
import AdmZip from 'adm-zip'
import {
  normalizeTemplateCategory,
  type CommunityTemplate,
  type TemplateInfo,
  type TemplateOrigin
} from '../../shared/projectTemplate'
import { extractZipSafely } from '../services/project/safeExtract'
import {
  addSource,
  listSources,
  removeSource,
  setSourceEnabled
} from '../services/project/templateSource'
import {
  cancelDownload,
  downloadTemplate,
  fetchEnabledSources
} from '../services/project/templateDownload'

/**
 * 本地模板目录（可读写）。
 *
 * **只有这一个目录。** 安装包里不再带任何模板 —— 用户自己打包的和从社区源下载来的
 * 都落在这里，靠边车 json 的 origin 区分。想知道为什么不随包发，
 * 见 docs/community-templates.md。
 */
function getUserTemplatesDir(): string {
  return path.join(app.getPath('userData'), 'templates')
}

/**
 * 列出本地可用的工程模板
 */
ipcMain.handle('projectTemplate:list', async () => {
  try {
    const userDir = getUserTemplatesDir()
    const templates: TemplateInfo[] = []

    const scanDir = async (dir: string): Promise<void> => {
      try {
        await fs.access(dir)
      } catch {
        await fs.mkdir(dir, { recursive: true })
        return
      }

      const files = await fs.readdir(dir)
      for (const file of files) {
        if (!file.toLowerCase().endsWith('.zip')) {
          continue
        }

        const filePath = path.join(dir, file)
        try {
          const stats = await fs.stat(filePath)
          const name = path.basename(file, '.zip')

          // 尝试读取元数据 JSON 文件
          const metaPath = path.join(dir, `${name}.json`)
          let metaData: Partial<TemplateInfo> = {}
          try {
            const metaContent = await fs.readFile(metaPath, 'utf-8')
            metaData = JSON.parse(metaContent)
          } catch {
            // 元数据文件不存在或解析失败，使用默认值
          }

          // 尝试查找预览图文件
          const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp']
          let previewImage: string | undefined
          for (const ext of imageExtensions) {
            const imagePath = path.join(dir, `${name}${ext}`)
            try {
              await fs.access(imagePath)
              previewImage = imagePath
              break
            } catch {
              // 文件不存在，继续尝试下一个扩展名
            }
          }

          // 根据模板名称推断分类
          let category = metaData.category
          if (!category) {
            const nameLower = name.toLowerCase()
            if (nameLower.includes('game') || nameLower.includes('游戏')) {
              category = 'game'
            } else if (nameLower.includes('render') || nameLower.includes('渲染')) {
              category = 'render'
            } else if (nameLower.includes('film') || nameLower.includes('影视')) {
              category = 'film'
            } else if (nameLower.includes('arch') || nameLower.includes('建筑')) {
              category = 'architecture'
            }
          }

          // 下载来的社区模板和用户自己打包的都在这个目录里，
          // 靠边车 json 的 origin 区分
          const origin: TemplateOrigin = metaData.origin === 'community' ? 'community' : 'user'

          templates.push({
            // 社区模板的文件名被 sanitize 过，显示名以边车里的原名为准
            name: metaData.name || name,
            path: filePath,
            size: stats.size,
            modifiedTime: stats.mtimeMs,
            origin,
            sourceId: metaData.sourceId,
            templateId: metaData.templateId,
            category: normalizeTemplateCategory(category),
            previewImage: previewImage || metaData.previewImage,
            description: metaData.description || `基于 ${name} 模板创建的项目`,
            version: metaData.version || '1.0.0',
            engineVersion: metaData.engineVersion || '5.3',
            author: metaData.author,
            license: metaData.license
          })
        } catch (err) {
          console.warn(`[projectTemplate:list] 读取文件信息失败: ${filePath}`, err)
        }
      }
    }

    await scanDir(userDir)

    // 按修改时间倒序排列（最新的在前）
    templates.sort((a, b) => b.modifiedTime - a.modifiedTime)

    return { success: true, templates }
  } catch (error) {
    console.error('[projectTemplate:list] 错误:', error)
    return {
      success: false,
      error: String(error instanceof Error ? error.message : error)
    }
  }
})

/**
 * 从模板创建工程
 */
ipcMain.handle(
  'projectTemplate:createFromTemplate',
  async (
    _,
    params: {
      templatePath: string
      targetDir: string
      projectName: string
    }
  ) => {
    void _
    const { templatePath, targetDir, projectName } = params

    try {
      // 1. 验证模板文件存在
      try {
        await fs.access(templatePath)
      } catch {
        return { success: false, error: '模板文件不存在' }
      }

      // 2. 验证目标目录可写
      try {
        await fs.mkdir(targetDir, { recursive: true })
      } catch (err) {
        return {
          success: false,
          error: `无法创建目标目录: ${String(err instanceof Error ? err.message : err)}`
        }
      }

      // 3. 创建临时解压目录
      const tempDir = path.join(targetDir, `.temp_${Date.now()}`)
      try {
        await fs.mkdir(tempDir, { recursive: true })
      } catch (err) {
        return {
          success: false,
          error: `无法创建临时目录: ${String(err instanceof Error ? err.message : err)}`
        }
      }

      let extractedRootDir: string | null = null

      try {
        // 4. 解压 zip 文件（走加固解压：模板包可能是从社区源下载来的，条目名不可信）
        const zip = new AdmZip(templatePath)
        await extractZipSafely(zip, tempDir)

        // 5. 查找解压后的 .uproject 文件
        const findUprojectFile = async (dir: string): Promise<string | null> => {
          const entries = await fs.readdir(dir, { withFileTypes: true })

          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isFile() && entry.name.endsWith('.uproject')) {
              return fullPath
            }
            if (entry.isDirectory()) {
              const found = await findUprojectFile(fullPath)
              if (found) {
                return found
              }
            }
          }
          return null
        }

        extractedRootDir = await findUprojectFile(tempDir)

        if (!extractedRootDir) {
          // 清理临时目录
          await fs.rm(tempDir, { recursive: true, force: true })
          return { success: false, error: '模板文件中未找到 .uproject 文件' }
        }

        // 6. 获取 .uproject 文件所在的根目录
        const uprojectDir = path.dirname(extractedRootDir)

        // 7. 构建目标工程目录
        const targetProjectDir = path.join(targetDir, projectName)

        // 检查目标目录是否已存在
        try {
          await fs.access(targetProjectDir)
          return { success: false, error: `目录 "${projectName}" 已存在` }
        } catch {
          // 目录不存在，继续
        }

        // 8. 复制解压后的工程目录到目标位置
        const copyDir = async (src: string, dest: string): Promise<void> => {
          await fs.mkdir(dest, { recursive: true })
          const entries = await fs.readdir(src, { withFileTypes: true })

          for (const entry of entries) {
            const srcPath = path.join(src, entry.name)
            const destPath = path.join(dest, entry.name)

            if (entry.isDirectory()) {
              await copyDir(srcPath, destPath)
            } else {
              // 使用流式复制，处理大文件
              await new Promise<void>((resolve, reject) => {
                const rs = nodeFs.createReadStream(srcPath)
                const ws = nodeFs.createWriteStream(destPath)
                rs.on('error', reject)
                ws.on('error', reject)
                ws.on('close', resolve)
                rs.pipe(ws)
              })
            }
          }
        }

        await copyDir(uprojectDir, targetProjectDir)

        // 9. 重命名 .uproject 文件为用户指定的项目名称
        const originalUprojectName = path.basename(extractedRootDir)
        const originalUprojectInTarget = path.join(targetProjectDir, originalUprojectName)
        const newUprojectName = `${projectName}.uproject`
        const targetUprojectPath = path.join(targetProjectDir, newUprojectName)

        // 如果原文件名与目标文件名不同，则进行重命名
        if (originalUprojectName !== newUprojectName) {
          try {
            await fs.rename(originalUprojectInTarget, targetUprojectPath)
          } catch (renameErr) {
            console.warn(
              `[projectTemplate:createFromTemplate] 重命名 .uproject 文件失败: ${String(renameErr)}`
            )
            // 重命名失败时返回原路径
            return {
              success: true,
              projectPath: targetProjectDir,
              uprojectPath: originalUprojectInTarget
            }
          }
        }

        // 10. 导入工程到数据库（通过 IPC，会自动触发注册的处理函数）
        // 注意：这里不能直接调用，需要通过事件通知或者返回路径让前端调用
        // 由于主进程 IPC 不能直接调用另一个 IPC handler，我们返回路径让前端调用

        // 11. 清理临时目录
        await fs.rm(tempDir, { recursive: true, force: true })

        return {
          success: true,
          projectPath: targetProjectDir,
          uprojectPath: targetUprojectPath
        }
      } catch (err) {
        // 清理临时目录
        try {
          await fs.rm(tempDir, { recursive: true, force: true })
        } catch {
          // 忽略清理错误
        }
        throw err
      }
    } catch (error) {
      console.error('[projectTemplate:createFromTemplate] 错误:', error)
      return {
        success: false,
        error: String(error instanceof Error ? error.message : error)
      }
    }
  }
)

/**
 * 添加自定义模板
 */
ipcMain.handle(
  'projectTemplate:addCustomTemplate',
  async (
    _,
    params: {
      sourceProjectPath: string
      templateName: string
    }
  ) => {
    void _
    const { sourceProjectPath, templateName } = params

    try {
      // 1. 验证源工程路径
      let uprojectPath: string | null = null

      try {
        const stats = await fs.stat(sourceProjectPath)
        if (stats.isFile() && sourceProjectPath.endsWith('.uproject')) {
          uprojectPath = sourceProjectPath
        } else if (stats.isDirectory()) {
          // 在目录中查找 .uproject 文件
          const entries = await fs.readdir(sourceProjectPath, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.uproject')) {
              uprojectPath = path.join(sourceProjectPath, entry.name)
              break
            }
          }
        }
      } catch {
        return { success: false, error: '源工程路径不存在' }
      }

      if (!uprojectPath) {
        return { success: false, error: '未找到 .uproject 文件' }
      }

      const projectDir = path.dirname(uprojectPath)

      // 2. 确保模板目录存在
      const templatesDir = getUserTemplatesDir()
      await fs.mkdir(templatesDir, { recursive: true })

      // 3. 构建目标 zip 文件路径
      const sanitizedName = templateName.replace(/[<>:"/\\|?*]/g, '_')
      const zipFileName = `${sanitizedName}.zip`
      const zipPath = path.join(templatesDir, zipFileName)

      // 检查文件是否已存在
      try {
        await fs.access(zipPath)
        return { success: false, error: `模板 "${templateName}" 已存在` }
      } catch {
        // 文件不存在，继续
      }

      // 4. 打包工程目录为 zip
      const zip = new AdmZip()

      // 递归添加目录内容到 zip
      const addDirectoryToZip = (dirPath: string, zipPath: string): void => {
        const entries = nodeFs.readdirSync(dirPath, { withFileTypes: true })

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name)
          const relativePath = path.join(zipPath, entry.name).replace(/\\/g, '/')

          if (entry.isDirectory()) {
            // 跳过一些不需要的目录
            const skipDirs = ['.git', 'Binaries', 'Intermediate', 'Saved', '.vs', '.idea']
            if (skipDirs.includes(entry.name)) {
              continue
            }
            addDirectoryToZip(fullPath, relativePath)
          } else {
            // 跳过一些不需要的文件
            const skipExts = ['.suo', '.sdf', '.opensdf', '.db', '.tmp']
            const ext = path.extname(entry.name).toLowerCase()
            if (skipExts.includes(ext)) {
              continue
            }
            zip.addLocalFile(fullPath, zipPath)
          }
        }
      }

      const projectName = path.basename(projectDir)
      addDirectoryToZip(projectDir, projectName)

      // 5. 保存 zip 文件
      zip.writeZip(zipPath)

      return {
        success: true,
        templatePath: zipPath,
        templateName: sanitizedName
      }
    } catch (error) {
      console.error('[projectTemplate:addCustomTemplate] 错误:', error)
      return {
        success: false,
        error: String(error instanceof Error ? error.message : error)
      }
    }
  }
)

/* ==========================================================================
 * 社区模板
 *
 * 注意这一段里**没有任何自动触发的网络请求**：清单只在渲染层显式调用
 * `projectTemplate:fetchCommunity` 时才抓，而那个入口在界面上要求先启用源。
 * 装好不动它，这个应用一个包都不会去连。
 * ========================================================================== */

function toErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

/**
 * 列出社区模板源
 */
ipcMain.handle('projectTemplate:listSources', async () => {
  try {
    return { success: true, sources: await listSources() }
  } catch (error) {
    console.error('[projectTemplate:listSources] 错误:', error)
    return { success: false, error: toErrorMessage(error) }
  }
})

/**
 * 启用 / 禁用一个源。启用是用户对"允许联网"的显式表态
 */
ipcMain.handle(
  'projectTemplate:setSourceEnabled',
  async (_, params: { id: string; enabled: boolean }) => {
    void _
    try {
      return { success: true, sources: await setSourceEnabled(params.id, params.enabled) }
    } catch (error) {
      return { success: false, error: toErrorMessage(error) }
    }
  }
)

/**
 * 添加自定义源
 */
ipcMain.handle('projectTemplate:addSource', async (_, params: { name: string; url: string }) => {
  void _
  try {
    return { success: true, sources: await addSource(params.name, params.url) }
  } catch (error) {
    return { success: false, error: toErrorMessage(error) }
  }
})

/**
 * 删除自定义源
 */
ipcMain.handle('projectTemplate:removeSource', async (_, params: { id: string }) => {
  void _
  try {
    return { success: true, sources: await removeSource(params.id) }
  } catch (error) {
    return { success: false, error: toErrorMessage(error) }
  }
})

/**
 * 抓取所有已启用源的清单
 */
ipcMain.handle('projectTemplate:fetchCommunity', async () => {
  try {
    const sources = await listSources()
    return { success: true, results: await fetchEnabledSources(sources) }
  } catch (error) {
    console.error('[projectTemplate:fetchCommunity] 错误:', error)
    return { success: false, error: toErrorMessage(error) }
  }
})

/**
 * 下载一条社区模板到本地模板库
 */
ipcMain.handle(
  'projectTemplate:downloadCommunity',
  async (event, params: { sourceId: string; template: CommunityTemplate }) => {
    try {
      const sources = await listSources()
      const source = sources.find((s) => s.id === params.sourceId)
      if (!source) {
        return { success: false, error: `模板源不存在：${params.sourceId}` }
      }
      if (!source.enabled) {
        return { success: false, error: '该模板源已被禁用' }
      }

      const targetDir = getUserTemplatesDir()
      await fs.mkdir(targetDir, { recursive: true })

      const result = await downloadTemplate({
        source,
        template: params.template,
        targetDir,
        onProgress: (progress) => {
          // 用发起下载的那个窗口，而不是当前聚焦窗口：下载期间用户可能切走了
          const win = BrowserWindow.fromWebContents(event.sender)
          win?.webContents.send('projectTemplate:downloadProgress', progress)
        }
      })

      return { success: true, templatePath: result.templatePath }
    } catch (error) {
      console.error('[projectTemplate:downloadCommunity] 错误:', error)
      return { success: false, error: toErrorMessage(error) }
    }
  }
)

/**
 * 取消一个进行中的下载
 */
ipcMain.handle(
  'projectTemplate:cancelDownload',
  async (_, params: { sourceId: string; templateId: string }) => {
    void _
    return { success: cancelDownload(params.sourceId, params.templateId) }
  }
)
