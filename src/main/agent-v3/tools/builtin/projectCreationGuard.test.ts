/**
 * 「建工程该走 project_manage」的提醒。
 *
 * 不拦，只提醒。用例分两半：**该提醒的提醒到**（真机上模型实际走过的那条路），
 * 以及**无关的命令不带提醒** —— 每条结果后面都挂一句，模型很快就会无视它。
 */

import { describe, expect, it } from 'vitest'

import { engineTemplateAdvice, uprojectWriteAdvice } from './projectCreationGuard'

describe('uprojectWriteAdvice', () => {
  it('写 .uproject 时提醒改用 create_project', () => {
    expect(uprojectWriteAdvice('I:/UE Project/MyGame/MyGame.uproject')).toContain('create_project')
  })

  it('大小写和结尾空白都认', () => {
    expect(uprojectWriteAdvice('D:/a/B.UPROJECT')).toBeDefined()
    expect(uprojectWriteAdvice('D:/a/B.uproject  ')).toBeDefined()
  })

  it('别的文件不带提醒 —— 写脚本、写配置是这个工具的正经用途', () => {
    expect(uprojectWriteAdvice('D:/tool/build.py')).toBeUndefined()
    expect(uprojectWriteAdvice('D:/MyGame/Config/DefaultEngine.ini')).toBeUndefined()
    // 名字里带 uproject 但不是那个扩展名，不该误伤
    expect(uprojectWriteAdvice('D:/notes/uproject-notes.md')).toBeUndefined()
    expect(uprojectWriteAdvice('D:/a/MyGame.uproject.bak')).toBeUndefined()
  })

  it('空路径不当成建工程', () => {
    expect(uprojectWriteAdvice('')).toBeUndefined()
  })
})

describe('engineTemplateAdvice', () => {
  it('真机上实际发生的那条命令带上提醒', () => {
    expect(
      engineTemplateAdvice(
        'cp -r "D:/Game/UE_5.5/Templates/TP_BlankBP" "I:/UE Project/MetaHumanDoubaoFullDuplex"'
      )
    ).toContain('create_project')
  })

  it('换一条拷贝命令一样提醒 —— 按目标路径判，不按动词判', () => {
    const commands = [
      'xcopy /E /I D:\\Game\\UE_5.5\\Templates\\TP_ThirdPersonBP D:\\Proj\\New',
      'robocopy "D:\\Game\\UE_5.5\\Templates\\TP_BlankBP" "D:\\Proj\\New" /E',
      'powershell Copy-Item -Recurse "D:/Game/UE_5.5/Templates/TP_BlankBP" D:/Proj/New',
      'tar -cf - -C "D:/Game/UE_5.5/Templates/TP_BlankBP" . | tar -xf - -C D:/Proj/New',
      'rsync -a /d/Game/UE_5.5/Templates/TP_TopDownBP/ /d/Proj/New/'
    ]
    for (const command of commands) {
      expect(engineTemplateAdvice(command), command).toBeDefined()
    }
  })

  it('引号和反斜杠的各种写法都认 —— 换个写法再试是模型最自然的下一步', () => {
    expect(engineTemplateAdvice('cp -r D:\\Game\\UE_5.5\\Templates\\TP_BlankBP x')).toBeDefined()
    expect(engineTemplateAdvice('cp -r "D:/Game/UE_5.5/Templates"/"TP_BlankBP" x')).toBeDefined()
  })

  it('共享内容包目录也提醒 —— 只搬小白人也是在拼一个半成品工程', () => {
    expect(
      engineTemplateAdvice(
        'cp -r "D:/Game/UE_5.5/Templates/TemplateResources/High/Characters/Content" D:/Proj/New/Content'
      )
    ).toBeDefined()
  })

  it('不碰模板目录的命令不带提醒', () => {
    const allowed = [
      'git status',
      'ls "D:/Game/UE_5.5/Engine/Binaries/Win64"',
      'cp -r D:/Assets/Rocks D:/MyGame/Content/Rocks',
      // 用户自己工程里的目录恰好叫 Templates，但底下不是 TP_ 模板
      'cp -r D:/MyGame/Content/Templates/Widgets D:/Other/Content'
    ]
    for (const command of allowed) {
      expect(engineTemplateAdvice(command), command).toBeUndefined()
    }
  })

  it('空命令不报错', () => {
    expect(engineTemplateAdvice('')).toBeUndefined()
  })

  it('提醒里给出正路和理由，且不再说「会被挡」', () => {
    const message = engineTemplateAdvice('cp -r X/Templates/TP_BlankBP Y') ?? ''
    expect(message).toContain('project_manage')
    expect(message).toContain('create_project')
    // 理由：登记进「我的项目」、装插件、共享内容包
    expect(message).toContain('我的项目')
    expect(message).toContain('UnrealAgentLink')
    expect(message).toContain('共享内容包')
    expect(message).not.toContain('会被挡')
  })

  it('只读命令（ls / cat）也只是提醒，不是拒绝 —— 返回的是附加说明', () => {
    const message = engineTemplateAdvice('ls "D:/Game/UE_5.5/Templates/TP_BlankBP/Content"')
    expect(message).toMatch(/^提醒/)
  })
})
