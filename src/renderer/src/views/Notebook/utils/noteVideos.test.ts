import { describe, expect, it } from 'vitest'

import { SAVABLE_VIDEO_EXTENSIONS, savableVideoExtension } from './noteVideos'

describe('savableVideoExtension', () => {
  it('认 MIME 类型', () => {
    expect(savableVideoExtension('video/mp4', 'demo.mp4')).toBe('mp4')
    expect(savableVideoExtension('video/webm', 'demo.webm')).toBe('webm')
  })

  it('video/ogg 归一成 ogv —— 落盘扩展名要和本地资源服务给的 Content-Type 对得上', () => {
    expect(savableVideoExtension('video/ogg', 'demo.ogv')).toBe('ogv')
  })

  it('MIME 为空时退而问文件名', () => {
    // 有些系统拖拽过来的 file.type 是空串
    expect(savableVideoExtension('', 'demo.mp4')).toBe('mp4')
    expect(savableVideoExtension('', 'a.b.c.webm')).toBe('webm')
  })

  it('大小写和空白都能吃下', () => {
    expect(savableVideoExtension('VIDEO/MP4', 'DEMO.MP4')).toBe('mp4')
    expect(savableVideoExtension('', 'demo.MP4')).toBe('mp4')
  })

  it('mov 一律拒绝 —— Chromium 播不了 QuickTime 容器', () => {
    // 存下去会是个几十兆的哑文件，比不让存更糟
    expect(savableVideoExtension('video/quicktime', 'demo.mov')).toBeNull()
    expect(savableVideoExtension('', 'demo.mov')).toBeNull()
  })

  it('其他视频格式也拒绝', () => {
    expect(savableVideoExtension('video/x-msvideo', 'demo.avi')).toBeNull()
    expect(savableVideoExtension('video/x-matroska', 'demo.mkv')).toBeNull()
    expect(savableVideoExtension('', 'demo.flv')).toBeNull()
  })

  it('非视频 MIME 不会因为文件名蒙混过关以外的方式通过', () => {
    // 名字对得上就收：有些系统给的 type 不可靠，以文件名为准
    expect(savableVideoExtension('application/octet-stream', 'demo.mp4')).toBe('mp4')
    // 名字也对不上就拒绝
    expect(savableVideoExtension('application/octet-stream', 'demo.bin')).toBeNull()
  })

  it('没有扩展名、空输入都不炸', () => {
    expect(savableVideoExtension('', '')).toBeNull()
    expect(savableVideoExtension('', undefined)).toBeNull()
    expect(savableVideoExtension('', 'noextension')).toBeNull()
  })

  it('白名单和主进程 note:saveVideo 那份必须一致', () => {
    // 这边多放一个，用户会先等一次上传再收到失败
    expect([...SAVABLE_VIDEO_EXTENSIONS].sort()).toEqual(['mp4', 'ogv', 'webm'])
  })
})
