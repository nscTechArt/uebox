import { describe, expect, it } from 'vitest'
import path from 'path'
import { contentPathToDiskPath, snapshotPathFor, snapshotRootFor } from './assetSnapshotPaths'

const PROJECT = path.join('D:', 'UE', 'ShooterGame')

describe('assetSnapshot 路径映射', () => {
  it('把 /Game 路径映射到工程 Content 下的 .uasset', () => {
    expect(contentPathToDiskPath(PROJECT, '/Game/Materials/M_Wood')).toBe(
      path.join(PROJECT, 'Content', 'Materials', 'M_Wood.uasset')
    )
  })

  it('去掉引擎路径里的对象名后缀', () => {
    expect(contentPathToDiskPath(PROJECT, '/Game/Materials/M_Wood.M_Wood')).toBe(
      path.join(PROJECT, 'Content', 'Materials', 'M_Wood.uasset')
    )
  })

  it('拒绝不在工程 Content 下的路径', () => {
    // 插件内容和引擎内容的映射规则不一样，原型阶段不碰
    expect(contentPathToDiskPath(PROJECT, '/Engine/BasicShapes/Cube')).toBeNull()
    expect(contentPathToDiskPath(PROJECT, '/MyPlugin/Stuff/Thing')).toBeNull()
    expect(contentPathToDiskPath(PROJECT, 'Materials/M_Wood')).toBeNull()
  })

  it('拒绝带 .. 的路径，避免写到工程外面去', () => {
    expect(contentPathToDiskPath(PROJECT, '/Game/../../etc/passwd')).toBeNull()
  })

  it('快照落在工程 Saved 目录下，按会话分开', () => {
    const root = snapshotRootFor(PROJECT, 'sid-1')

    expect(root).toBe(path.join(PROJECT, 'Saved', 'UnrealBox', 'Snapshots', 'sid-1'))
    // 会话 ID 来自渲染层，不能直接当目录名用
    expect(snapshotRootFor(PROJECT, '../../evil')).toBe(
      path.join(PROJECT, 'Saved', 'UnrealBox', 'Snapshots', '______evil')
    )
  })

  it('快照文件镜像 Content 的层级，方便人工翻找', () => {
    expect(snapshotPathFor(PROJECT, 'sid-1', '/Game/Materials/M_Wood', 1234)).toBe(
      path.join(
        PROJECT,
        'Saved',
        'UnrealBox',
        'Snapshots',
        'sid-1',
        '1234',
        'Materials',
        'M_Wood.uasset'
      )
    )
    expect(snapshotPathFor(PROJECT, 'sid-1', '/Engine/Cube', 1234)).toBeNull()
  })
})
