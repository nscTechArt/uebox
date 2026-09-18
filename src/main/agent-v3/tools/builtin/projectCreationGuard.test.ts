/**
 * 「建工程只能走 project_manage」这道边界。
 *
 * 用例分两半：**该挡的挡住**（真机上模型实际走过的那条路），
 * 以及**不该挡的别挡** —— 一道把正常操作也拦掉的墙，用户会要求关掉它，
 * 那就等于没有。
 */

import { describe, expect, it } from 'vitest'

import { assertNotCopyingEngineTemplate, assertNotWritingUproject } from './projectCreationGuard'

describe('assertNotWritingUproject', () => {
  it('挡住自己写 .uproject 建工程', () => {
    expect(assertNotWritingUproject('I:/UE Project/MyGame/MyGame.uproject')).toContain(
      'create_project'
    )
  })

  it('大小写和结尾空白都认', () => {
    expect(assertNotWritingUproject('D:/a/B.UPROJECT')).toBeDefined()
    expect(assertNotWritingUproject('D:/a/B.uproject  ')).toBeDefined()
  })

  it('别的文件一律放行 —— 写脚本、写配置是这个工具的正经用途', () => {
    expect(assertNotWritingUproject('D:/tool/build.py')).toBeUndefined()
    expect(assertNotWritingUproject('D:/MyGame/Config/DefaultEngine.ini')).toBeUndefined()
    // 名字里带 uproject 但不是那个扩展名，不该误伤
    expect(assertNotWritingUproject('D:/notes/uproject-notes.md')).toBeUndefined()
    expect(assertNotWritingUproject('D:/a/MyGame.uproject.bak')).toBeUndefined()
  })

  it('空路径不当成建工程', () => {
    expect(assertNotWritingUproject('')).toBeUndefined()
  })
})

describe('assertNotCopyingEngineTemplate', () => {
  it('挡住真机上实际发生的那条命令', () => {
    expect(
      assertNotCopyingEngineTemplate(
        'cp -r "D:/Game/UE_5.5/Templates/TP_BlankBP" "I:/UE Project/MetaHumanDoubaoFullDuplex"'
      )
    ).toContain('create_project')
  })

  it('换一条拷贝命令一样挡 —— 按目标路径判，不按动词判', () => {
    const commands = [
      'xcopy /E /I D:\\Game\\UE_5.5\\Templates\\TP_ThirdPersonBP D:\\Proj\\New',
      'robocopy "D:\\Game\\UE_5.5\\Templates\\TP_BlankBP" "D:\\Proj\\New" /E',
      'powershell Copy-Item -Recurse "D:/Game/UE_5.5/Templates/TP_BlankBP" D:/Proj/New',
      'tar -cf - -C "D:/Game/UE_5.5/Templates/TP_BlankBP" . | tar -xf - -C D:/Proj/New',
      'rsync -a /d/Game/UE_5.5/Templates/TP_TopDownBP/ /d/Proj/New/'
    ]
    for (const command of commands) {
      expect(assertNotCopyingEngineTemplate(command), command).toBeDefined()
    }
  })

  it('引号和反斜杠的各种写法都认 —— 换个写法再试是模型最自然的下一步', () => {
    expect(
      assertNotCopyingEngineTemplate('cp -r D:\\Game\\UE_5.5\\Templates\\TP_BlankBP x')
    ).toBeDefined()
    expect(
      assertNotCopyingEngineTemplate('cp -r "D:/Game/UE_5.5/Templates"/"TP_BlankBP" x')
    ).toBeDefined()
  })

  it('共享内容包目录也挡 —— 只搬小白人也是在拼一个半成品工程', () => {
    expect(
      assertNotCopyingEngineTemplate(
        'cp -r "D:/Game/UE_5.5/Templates/TemplateResources/High/Characters/Content" D:/Proj/New/Content'
      )
    ).toBeDefined()
  })

  it('不碰模板目录的命令一律放行', () => {
    const allowed = [
      'git status',
      'ls "D:/Game/UE_5.5/Engine/Binaries/Win64"',
      'cp -r D:/Assets/Rocks D:/MyGame/Content/Rocks',
      // 用户自己工程里的目录恰好叫 Templates，但底下不是 TP_ 模板
      'cp -r D:/MyGame/Content/Templates/Widgets D:/Other/Content'
    ]
    for (const command of allowed) {
      expect(assertNotCopyingEngineTemplate(command), command).toBeUndefined()
    }
  })

  it('空命令不报错', () => {
    expect(assertNotCopyingEngineTemplate('')).toBeUndefined()
  })

  it('拦下来的话里要给出正路，不能只说「不行」', () => {
    const message = assertNotCopyingEngineTemplate('cp -r X/Templates/TP_BlankBP Y')
    expect(message).toContain('project_manage')
    expect(message).toContain('create_project')
    // 明确告诉它换命令没用，否则它会一条条试过去
    expect(message).toContain('一样会被挡')
  })
})
