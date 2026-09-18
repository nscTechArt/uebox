/**
 * 阿里云百炼临时文件上传服务
 * 上传本地文件至阿里云百炼临时存储空间，获取临时 URL（有效期48小时）
 *
 * 使用限制：
 * - 文件与模型绑定：上传时必须指定模型名称，且与后续调用模型一致
 * - 文件与主账号绑定：上传与调用需使用同一阿里云主账号下的 API Key
 * - 文件有效期：48小时后自动清理
 * - 上传限流：按"阿里云主账号+模型"维度限制 100 QPS
 */

import { net } from 'electron'
import { readFile, stat } from 'fs/promises'
import { basename, extname } from 'path'
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import { randomUUID } from 'crypto'

/**
 * 上传凭证接口返回类型
 */
interface UploadPolicyData {
  policy: string
  signature: string
  upload_dir: string
  upload_host: string
  expire_in_seconds: number
  max_file_size_mb: number
  capacity_limit_mb: number
  oss_access_key_id: string
  x_oss_object_acl: string
  x_oss_forbid_overwrite: string
}

/**
 * 上传凭证接口响应类型
 */
interface UploadPolicyResponse {
  request_id: string
  data: UploadPolicyData
}

/**
 * 上传结果类型
 */
export interface OssUploadResult {
  success: boolean
  ossUrl?: string
  expireTime?: string
  error?: string
}

/**
 * 配置选项
 */
export interface OssUploadOptions {
  /** 阿里云百炼 API Key；仅开发环境（BYOK）提供，打包后为空并改走服务端代理 */
  apiKey?: string
  modelName: string
  filePath: string
  /** 登录令牌，走服务端代理换取上传凭证时必需 */
}

/**
 * 获取文件上传凭证
 * @param apiKey - 阿里云百炼 API Key
 * @param modelName - 目标模型名称（如 qwen-vl-plus）
 * @returns 上传凭证数据
 */
async function getUploadPolicy(
  apiKey: string | undefined,
  modelName: string
): Promise<UploadPolicyData> {
  if (!apiKey) throw new Error('请配置百炼 API Key')

  return new Promise((resolve, reject) => {
    const url = `https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(modelName)}`

    const request = net.request({
      method: 'GET',
      url,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    })

    let responseData = ''

    request.on('response', (response) => {
      response.on('data', (chunk) => {
        responseData += chunk.toString()
      })

      response.on('end', () => {
        try {
          if (response.statusCode !== 200) {
            reject(new Error(`获取上传凭证失败: HTTP ${response.statusCode}, ${responseData}`))
            return
          }

          // 两条路径的信封都以 data 承载 policy：
          // 直连是 DashScope 的 { data }，代理是服务端的 { ok, data }（原样透传）
          const parsed: UploadPolicyResponse = JSON.parse(responseData)
          if (!parsed.data) {
            reject(new Error(`获取上传凭证失败: 响应数据格式错误`))
            return
          }

          resolve(parsed.data)
        } catch (error) {
          reject(new Error(`解析上传凭证响应失败: ${error}`))
        }
      })

      response.on('error', (error) => {
        reject(new Error(`获取上传凭证网络错误: ${error.message}`))
      })
    })

    request.on('error', (error) => {
      reject(new Error(`获取上传凭证请求失败: ${error.message}`))
    })

    request.end()
  })
}

/**
 * 构建 multipart/form-data 请求体
 * @param policyData - 上传凭证数据
 * @param key - 文件在 OSS 中的完整路径
 * @param fileName - 文件名
 * @param fileBuffer - 文件内容
 * @returns 请求体 Buffer 和边界字符串
 */
function buildMultipartFormData(
  policyData: UploadPolicyData,
  key: string,
  fileName: string,
  fileBuffer: Buffer
): { body: Buffer; boundary: string } {
  const boundary = `----WebKitFormBoundary${Date.now().toString(36)}`
  const crlf = '\r\n'

  // 对文件名进行安全编码（移除或替换特殊字符）
  // 仅作为 Content-Disposition 的 filename 参数，不影响 OSS Key
  const safeFileName = encodeURIComponent(fileName).replace(/%20/g, '_')

  // OSS key 使用 ASCII 字符，不包含特殊字符
  const safeKey = key

  // 表单字段
  const fields: Array<[string, string]> = [
    ['OSSAccessKeyId', policyData.oss_access_key_id],
    ['Signature', policyData.signature],
    ['policy', policyData.policy],
    ['x-oss-object-acl', policyData.x_oss_object_acl],
    ['x-oss-forbid-overwrite', policyData.x_oss_forbid_overwrite],
    ['key', safeKey],
    ['success_action_status', '200']
  ]

  // 构建表单字段部分
  const fieldParts: Buffer[] = []
  for (const [name, value] of fields) {
    const fieldHeader =
      `--${boundary}${crlf}` + `Content-Disposition: form-data; name="${name}"${crlf}${crlf}`
    fieldParts.push(Buffer.from(fieldHeader, 'utf-8'))
    fieldParts.push(Buffer.from(value, 'utf-8'))
    fieldParts.push(Buffer.from(crlf, 'utf-8'))
  }

  // 构建文件部分（使用安全文件名）
  const fileHeader =
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="file"; filename="${safeFileName}"${crlf}` +
    `Content-Type: application/octet-stream${crlf}${crlf}`
  const fileFooter = `${crlf}--${boundary}--${crlf}`

  // 合并所有部分
  const body = Buffer.concat([
    ...fieldParts,
    Buffer.from(fileHeader, 'utf-8'),
    fileBuffer,
    Buffer.from(fileFooter, 'utf-8')
  ])

  return { body, boundary }
}

/**
 * 上传文件到 OSS 临时存储
 * @param policyData - 上传凭证数据
 * @param filePath - 本地文件路径
 * @returns OSS 临时 URL（以 oss:// 为前缀）
 */
async function uploadFileToOss(policyData: UploadPolicyData, filePath: string): Promise<string> {
  const originalFileName = basename(filePath)
  const ext = extname(originalFileName)

  // 生成随机文件名 (UUID)，避免中文/特殊字符编码问题
  const randomName = `${randomUUID()}${ext}`
  const key = `${policyData.upload_dir}/${randomName}`

  // 读取文件内容
  const fileBuffer = await readFile(filePath)

  // 构建 multipart 请求体
  // 使用原始文件名作为 Content-Disposition 的 filename，方便下载时识别
  const { body, boundary } = buildMultipartFormData(policyData, key, originalFileName, fileBuffer)

  return new Promise((resolve, reject) => {
    // 验证 upload_host 是否有效
    console.log(`[OSS Upload] upload_host: ${policyData.upload_host}`)
    console.log(`[OSS Upload] key: ${key} (Original: ${originalFileName})`)
    console.log(`[OSS Upload] body size: ${body.length} bytes`)

    if (!policyData.upload_host || !policyData.upload_host.startsWith('http')) {
      reject(new Error(`无效的上传地址: ${policyData.upload_host}`))
      return
    }

    // 使用 Node.js https 模块进行上传
    const parsedUrl = new URL(policyData.upload_host)
    const isHttps = parsedUrl.protocol === 'https:'
    const httpModule = isHttps ? https : http

    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }

    const request = httpModule.request(options, (response) => {
      let responseData = ''

      response.on('data', (chunk) => {
        responseData += chunk.toString()
      })

      response.on('end', () => {
        if (response.statusCode === 200) {
          // 成功：返回 OSS URL
          // key 是纯 ASCII 的，不需要额外编码
          resolve(`oss://${key}`)
        } else {
          reject(new Error(`上传文件失败: HTTP ${response.statusCode}, ${responseData}`))
        }
      })

      response.on('error', (error) => {
        console.error(`[OSS Upload] 响应错误:`, error)
        reject(new Error(`上传文件网络错误: ${error.message}`))
      })
    })

    request.on('error', (error) => {
      console.error(`[OSS Upload] 请求错误:`, error)
      console.error(`[OSS Upload] 错误类型: ${error.name}`)
      console.error(`[OSS Upload] 错误代码: ${(error as NodeJS.ErrnoException).code}`)
      console.error(`[OSS Upload] 错误堆栈:`, error.stack)
      reject(new Error(`上传文件请求失败: ${error.message}`))
    })

    // 写入请求体
    console.log(`[OSS Upload] 正在写入请求体...`)
    request.write(body)
    request.end()
    console.log(`[OSS Upload] 请求已发送，等待响应...`)
  })
}

/**
 * 上传文件并获取临时 URL
 *
 * @param options - 上传选项
 * @param options.apiKey - 阿里云百炼 API Key
 * @param options.modelName - 目标模型名称（如 qwen-vl-plus, qwen3-vl-flash）
 * @param options.filePath - 本地文件路径
 * @returns 上传结果，包含临时 URL 和过期时间
 *
 * @example
 * ```typescript
 * const result = await uploadFileAndGetUrl({
 *   apiKey: 'sk-xxx',
 *   modelName: 'qwen-vl-plus',
 *   filePath: '/path/to/image.png'
 * })
 * if (result.success) {
 *   console.log('临时URL:', result.ossUrl) // oss://dashscope-instant/xxx/2024-07-18/xxxx/image.png
 *   console.log('过期时间:', result.expireTime)
 * }
 * ```
 */
export async function uploadFileAndGetUrl(options: OssUploadOptions): Promise<OssUploadResult> {
  const { apiKey, modelName, filePath } = options

  // 验证参数
  if (!apiKey) {
    return { success: false, error: '请先配置模型服务的 API Key' }
  }
  if (!modelName) {
    return { success: false, error: '模型名称不能为空' }
  }
  if (!filePath) {
    return { success: false, error: '文件路径不能为空' }
  }

  try {
    // 0. 验证文件是否存在
    console.log(`[OSS Upload] 检查文件是否存在: ${filePath}`)
    try {
      const fileStat = await stat(filePath)
      console.log(`[OSS Upload] 文件大小: ${fileStat.size} bytes`)
      if (!fileStat.isFile()) {
        return { success: false, error: '路径不是一个有效的文件' }
      }
    } catch (statError) {
      console.error(`[OSS Upload] 文件不存在或无法访问:`, statError)
      return { success: false, error: `文件不存在或无法访问: ${filePath}` }
    }

    // 1. 获取上传凭证
    console.log(`[OSS Upload] 获取上传凭证，模型: ${modelName}`)
    const policyData = await getUploadPolicy(apiKey, modelName)
    console.log(
      `[OSS Upload] 凭证获取成功:`,
      JSON.stringify({
        upload_host: policyData.upload_host,
        upload_dir: policyData.upload_dir,
        oss_access_key_id: policyData.oss_access_key_id?.slice(0, 8) + '...'
      })
    )

    // 2. 上传文件到 OSS
    console.log(`[OSS Upload] 开始上传文件: ${filePath}`)
    const ossUrl = await uploadFileToOss(policyData, filePath)

    // 3. 计算过期时间（48小时）
    const expireTime = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()

    console.log(`[OSS Upload] 上传成功: ${ossUrl}`)
    return {
      success: true,
      ossUrl,
      expireTime
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[OSS Upload] 上传失败:`, errorMessage)
    return {
      success: false,
      error: errorMessage
    }
  }
}

/**
 * 默认模型名称（视觉模型）
 * 可通过 ai-defaults 接口的 vl 参数覆盖
 */
export const DEFAULT_VL_MODEL = 'qwen3-vl-flash'
