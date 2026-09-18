import { describe, expect, it } from 'vitest'

import { splitSoftPath } from './assetDependency'

describe('splitSoftPath', () => {
  it('把末段资产名和所在目录拆开', () => {
    expect(splitSoftPath('/Game/EasyFog/Textures/Mountain/T_MountainMask_02')).toEqual({
      name: 'T_MountainMask_02',
      folder: '/Game/EasyFog/Textures/Mountain'
    })
  })

  it('剥掉 UE 软路径末段的 .ObjectName 后缀', () => {
    // 用户想看的是 M_Rock，不是 M_Rock.M_Rock
    expect(splitSoftPath('/Game/Env/M_Rock.M_Rock')).toEqual({
      name: 'M_Rock',
      folder: '/Game/Env'
    })
  })

  it('没有目录的路径也能拆', () => {
    expect(splitSoftPath('T_Solo')).toEqual({ name: 'T_Solo', folder: '' })
  })

  it('反斜杠路径归一成正斜杠', () => {
    expect(splitSoftPath('\\Game\\Env\\T_Wall')).toEqual({
      name: 'T_Wall',
      folder: '/Game/Env'
    })
  })

  it('空串不炸', () => {
    expect(splitSoftPath('')).toEqual({ name: '', folder: '' })
  })

  it('末段以点开头时不会把名字吃光', () => {
    // dot === 0，不该切成空字符串
    expect(splitSoftPath('/Game/.hidden').name).toBe('.hidden')
  })
})
