/**
 * 通用资产更新通道的字段闸。
 *
 * 修复前 `db:assetData:update` 对字段没有任何限制，渲染层可以随手改任意一列 ——
 * 包括 imgLocalPath。把它改成 `../../vault-data.db` 再删掉这个资产，
 * 后台清理删的就是保管库数据库本体。
 */
import { describe, expect, it } from 'vitest'

import { assetUpdateRejectionMessage, checkRendererAssetUpdate } from './updateGuard'

describe('checkRendererAssetUpdate', () => {
  it('改名、换封面这类正常更新放行', () => {
    expect(checkRendererAssetUpdate({ assetName: '战士' }).ok).toBe(true)
    expect(checkRendererAssetUpdate({ customPoster: 'custom-1.jpg' }).ok).toBe(true)
    expect(checkRendererAssetUpdate({ note: '备注', tags: '["a"]' } as never).ok).toBe(true)
  })

  it('带路径的缩略图字段挡下 —— 它是后台删文件的定位依据', () => {
    const result = checkRendererAssetUpdate({ imgLocalPath: '../../vault-data.db' })
    expect(result.ok).toBe(false)
    expect(result.rejected).toEqual(['imgLocalPath'])
  })

  it('缩略图生成回写 imgLocalPath 必须放行 —— 整列拉黑会让缩略图永远出不来', () => {
    // asset:saveThumbnail 返回的就是一个纯文件名，渲染层拿它写库
    expect(checkRendererAssetUpdate({ imgLocalPath: 'asset_123_thumb.jpg' }).ok).toBe(true)
  })

  it('清空缩略图字段是合法操作（重置为默认预览图）', () => {
    expect(checkRendererAssetUpdate({ imgLocalPath: '' }).ok).toBe(true)
    expect(checkRendererAssetUpdate({ customPoster: '' }).ok).toBe(true)
  })

  it('真正的路径列仍然整列禁止', () => {
    expect(checkRendererAssetUpdate({ filePath: 'x.uasset' }).rejected).toEqual(['filePath'])
    expect(checkRendererAssetUpdate({ originPath: 'x' } as never).rejected).toEqual(['originPath'])
  })

  it('状态列各有专门通道，不许绕过', () => {
    expect(checkRendererAssetUpdate({ isDelete: 1 } as never).rejected).toEqual(['isDelete'])
    expect(checkRendererAssetUpdate({ folderKey: 'x' }).rejected).toEqual(['folderKey'])
  })

  it('一次夹带多个受保护字段时全部列出来', () => {
    const result = checkRendererAssetUpdate({
      assetName: '战士',
      filePath: 'x',
      isDelete: 1
    } as never)
    expect(result.ok).toBe(false)
    expect(result.rejected.sort()).toEqual(['filePath', 'isDelete'])
  })

  it('渲染层实际在用的那批字段全部放行', () => {
    // 逐个对应 AssetDetailsPanel / AssetFileList / useVideoThumbnail 的真实调用
    for (const updates of [
      { customPoster: 'custom-1.jpg' },
      { note: '备注' },
      { color: '#FF5733' },
      { assetName: '战士' },
      { baiduyunPath: '/apps/x.png' },
      { webdavPath: '/dav/x.png' },
      { imgLocalPath: 'a_thumb.jpg' }
    ] as never[]) {
      expect(checkRendererAssetUpdate(updates).rejected).toEqual([])
    }
  })

  it('空更新不报错', () => {
    expect(checkRendererAssetUpdate({}).ok).toBe(true)
    expect(checkRendererAssetUpdate(null).ok).toBe(true)
    expect(checkRendererAssetUpdate(undefined).ok).toBe(true)
  })

  it('错误信息指向应该走的通道，别让调用方猜', () => {
    const message = assetUpdateRejectionMessage(['isDelete'])
    expect(message).toContain('isDelete')
    expect(message).toContain('moveToFolder')
  })
})
