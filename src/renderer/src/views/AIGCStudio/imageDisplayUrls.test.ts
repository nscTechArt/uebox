import { describe, expect, it } from 'vitest'

import { getTaskDisplayUrls } from './imageStore'

/**
 * 老记录能不能显示，全看这个函数。
 *
 * `imageUrls` 是模型那边给的地址（会过期的远端链接、或者很长的 base64），
 * `localPaths` 是已经存进资产库的那份。重启之后只有后者还靠得住。
 */
describe('生成记录的显示地址', () => {
  it('有本地副本就用本地副本，不用会过期的远端链接', () => {
    expect(
      getTaskDisplayUrls({
        imageUrls: ['https://cdn.example.com/expires-soon.png'],
        localPaths: ['H:/资产库/AIGC/图片/剑_1.png']
      })
    ).toEqual([
      'local-resource://H:/%E8%B5%84%E4%BA%A7%E5%BA%93/AIGC/%E5%9B%BE%E7%89%87/%E5%89%91_1.png'
    ])
  })

  it('没有本地副本（升级前的老记录）就回落到原来的地址', () => {
    expect(
      getTaskDisplayUrls({
        imageUrls: ['https://cdn.example.com/old.png'],
        localPaths: undefined
      })
    ).toEqual(['https://cdn.example.com/old.png'])
  })

  it('逐格回落：某一张没存下来，不连累同一条记录里的其它张', () => {
    const urls = getTaskDisplayUrls({
      imageUrls: ['https://cdn.example.com/0.png', 'https://cdn.example.com/1.png'],
      // 第二张保存失败，只留了空位
      localPaths: ['C:/vault/0.png', '']
    })

    expect(urls).toEqual(['local-resource://C:/vault/0.png', 'https://cdn.example.com/1.png'])
  })

  it('下标和 localPaths 对得上 —— 下载是按下标取本地文件的', () => {
    const task = {
      imageUrls: ['https://cdn.example.com/front.png', 'https://cdn.example.com/left.png'],
      localPaths: ['C:/vault/front.png', 'C:/vault/left.png']
    }

    const urls = getTaskDisplayUrls(task)

    expect(urls).toHaveLength(task.localPaths.length)
    expect(urls[1]).toBe('local-resource://C:/vault/left.png')
  })

  it('base64 结果没有本地副本时原样返回', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='

    expect(getTaskDisplayUrls({ imageUrls: [dataUrl], localPaths: [] })).toEqual([dataUrl])
  })

  it('没有任何图片时给空数组，不给 undefined', () => {
    expect(getTaskDisplayUrls(null)).toEqual([])
    expect(getTaskDisplayUrls({ imageUrls: [], localPaths: [] })).toEqual([])
  })
})
