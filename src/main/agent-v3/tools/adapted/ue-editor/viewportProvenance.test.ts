/**
 * 「视口最后是谁动的」这条记录。
 *
 * 守的是措辞：有记录就说工具名、多久前、怎么动的，并留一句「用户也可能动过」；
 * 没记录一个字都不说 —— 说不准的时候不说。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  describeViewportProvenance,
  lastViewportMove,
  noteViewportMove,
  resetViewportProvenance,
  viewportCameraApiInScript
} from './viewportProvenance'

beforeEach(() => resetViewportProvenance())

describe('describeViewportProvenance', () => {
  it('没记录时一个字都不加', () => {
    expect(describeViewportProvenance()).toBe('')
  })

  it('有记录时说清工具、多久前、怎么动的，并留一句用户也可能动过', () => {
    noteViewportMove('ue_run_python_script', '脚本里调了 set_level_viewport_camera_info', 1000)
    const text = describeViewportProvenance(13_000)
    expect(text).toContain('12 秒前')
    expect(text).toContain('ue_run_python_script')
    expect(text).toContain('set_level_viewport_camera_info')
    expect(text).toContain('用户也可能自己动过')
  })

  it('分钟级和小时级换单位', () => {
    noteViewportMove('ue_focus_viewport', '对准 BP_Chair', 0)
    expect(describeViewportProvenance(5 * 60_000)).toContain('5 分钟前')
    expect(describeViewportProvenance(3 * 3_600_000)).toContain('3 小时前')
  })

  it('后来的记录覆盖先前的', () => {
    noteViewportMove('a', 'x', 1)
    noteViewportMove('b', 'y', 2)
    expect(lastViewportMove()).toMatchObject({ tool: 'b', detail: 'y' })
  })
})

describe('viewportCameraApiInScript', () => {
  it('认得会动视口相机的那几个 API', () => {
    expect(
      viewportCameraApiInScript(
        'unreal.UnrealEditorSubsystem().set_level_viewport_camera_info(loc, rot)'
      )
    ).toBe('set_level_viewport_camera_info')
    expect(viewportCameraApiInScript('les.pilot_level_actor(actor)')).toBe('pilot_level_actor')
  })

  it('普通脚本不算', () => {
    expect(
      viewportCameraApiInScript('print(unreal.EditorLevelLibrary.get_all_level_actors())')
    ).toBeNull()
  })
})
