/**
 * 团队工程在服务器库能力上的改动（界面方案 4.0 对照表）：最近删除可用，网盘和拖进来导入置灰
 * 并说为什么；本地库和普通服务器库的能力里没有团队（界面一行不变）。
 */
import { describe, expect, it } from 'vitest'
import { LOCAL_CAPABILITIES } from './LocalLibrarySource'
import {
  SERVER_CAPABILITIES_BASE,
  serverCapabilities,
  teamCapabilities
} from './ServerLibrarySource'

describe('team capabilities', () => {
  const base = serverCapabilities({ annotations: true, lore: true, online: true })

  it('local and plain server libraries are not team projects', () => {
    expect(LOCAL_CAPABILITIES.team).toBeNull()
    expect(SERVER_CAPABILITIES_BASE.team).toBeNull()
    expect(base.team).toBeNull()
  })

  it('a member sees recently deleted, and gets the reason why drag-in and cloud drives are off', () => {
    const caps = teamCapabilities(base, { role: 'member', local: false })
    expect(caps.team).toEqual({ role: 'member', local: false })
    expect(caps.hasTrash).toBe(true)
    expect(caps.canImport).toBe(false)
    expect(caps.cloudDrives).toBe(false)
    expect(caps.reasons.canImport).toBe('teamProject.reasons.import')
    expect(caps.reasons.cloudDrives).toBe('teamProject.reasons.cloudDrives')
    // 导入到工程照旧
    expect(caps.canSendToProject).toBe(base.canSendToProject)
  })

  it('an outsourcer has no recently deleted', () => {
    expect(teamCapabilities(base, { role: 'outsourcer', local: false }).hasTrash).toBe(false)
  })
})
