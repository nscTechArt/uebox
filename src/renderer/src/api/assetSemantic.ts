import { unwrapResult } from '@renderer/common/utils'

/**
 * 资产库语义搜索的开关和进度。
 *
 * 语义搜索让「椅子」能搜到 SM_Chair_Wood —— 关键词搜索做不到这件事，
 * 因为这两个字符串一个字都不重合。代价是每个资产都要调一次嵌入模型算向量，
 * 所以默认关闭，由用户在资产库设置里自己决定开不开。
 */
export const assetSemanticAPI = {
  async status(): Promise<AssetSemanticStatus> {
    const res = await window.api.database.assetSemantic.status()
    return unwrapResult<AssetSemanticStatus>(res, '读取语义搜索状态失败')
  },

  async enable(): Promise<AssetSemanticStatus> {
    const res = await window.api.database.assetSemantic.enable()
    return unwrapResult<AssetSemanticStatus>(res, '开启语义搜索失败')
  },

  async disable(): Promise<AssetSemanticStatus> {
    const res = await window.api.database.assetSemantic.disable()
    return unwrapResult<AssetSemanticStatus>(res, '关闭语义搜索失败')
  },

  /** 上一轮报错停下来了，修好之后接着算 */
  async resume(): Promise<AssetSemanticStatus> {
    const res = await window.api.database.assetSemantic.resume()
    return unwrapResult<AssetSemanticStatus>(res, '继续建索引失败')
  }
}

export default assetSemanticAPI
