/**
 * 引擎自带模板的解析与实例化。
 *
 * 用例里的 ini 片段是从 UE 5.5 的 `Templates/TP_BlankBP/Config/TemplateDefs.ini`
 * 和 `TP_ThirdPersonBP/Config/TemplateDefs.ini` 原样抄来的 —— 自己编一份格式，
 * 测的就只是自己的想象。
 */

import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  expandPlaceholders,
  instantiateEngineTemplate,
  listEngineTemplates,
  parseTemplateDefs,
  rewriteFileContent,
  rewriteRelativePath,
  shouldSkip,
  validateProjectName,
  type EngineTemplate
} from './engineTemplates'

/** TP_BlankBP 的真实 TemplateDefs.ini（含 UTF-8 BOM） */
const BLANK_DEFS = `\uFEFF[/Script/GameProjectGeneration.TemplateProjectDefs]

SortKey="_1"

bIsBlank=True

Categories=Games

LocalizedDisplayNames=(Language="en", Text="Blank")
LocalizedDescriptions=(Language="en", Text="A clean empty project with no code.")
LocalizedDisplayNames=(Language="zh-Hans", Text="空白")
LocalizedDescriptions=(Language="zh-Hans", Text="不含任何代码的空白项目。")

FoldersToIgnore=Media

FilesToIgnore="%TEMPLATENAME%.uproject"
FilesToIgnore="%TEMPLATENAME%.png"
FilesToIgnore="Config/TemplateDefs.ini"

FolderRenames=(From="Source/%TEMPLATENAME%", To="Source/%PROJECTNAME%")

FilenameReplacements=(Extensions=("cpp","h","ini","cs"), From="%TEMPLATENAME%", To="%PROJECTNAME%", bCaseSensitive=false)

ReplacementsInFiles=(Extensions=("cpp","h","ini","cs"), From="%TEMPLATENAME_UPPERCASE%", To="%PROJECTNAME_UPPERCASE%", bCaseSensitive=true)
ReplacementsInFiles=(Extensions=("cpp","h","ini","cs"), From="%TEMPLATENAME%", To="%PROJECTNAME%", bCaseSensitive=false)
`

/** TP_ThirdPersonBP 声明共享内容包的那两行 */
const THIRD_PERSON_DEFS = `${BLANK_DEFS}
FoldersToIgnore=Binaries
FoldersToIgnore=Intermediate
SharedContentPacks=(MountName="LevelPrototyping",DetailLevels=("High"))
SharedContentPacks=(MountName="Characters",DetailLevels=("High"))
`

describe('parseTemplateDefs', () => {
  it('中文显示名优先于英文 —— 界面是中文的，给英文名用户对不上 UE 项目浏览器', () => {
    const defs = parseTemplateDefs(BLANK_DEFS)
    expect(defs.displayName).toBe('空白')
    expect(defs.description).toBe('不含任何代码的空白项目。')
  })

  it('同名键重复出现时全部收下，不是后面覆盖前面', () => {
    const defs = parseTemplateDefs(BLANK_DEFS)
    expect(defs.filesToIgnore).toEqual([
      '%TEMPLATENAME%.uproject',
      '%TEMPLATENAME%.png',
      'Config/TemplateDefs.ini'
    ])
  })

  it('BOM 不会污染第一个键', () => {
    // 不去 BOM 的话首行的键名前面会挂一个不可见字符，后面的解析照样能跑，
    // 所以这里断言的是「解析结果对」而不是「没抛异常」
    expect(parseTemplateDefs(BLANK_DEFS).sortKey).toBe('_1')
    expect(parseTemplateDefs(BLANK_DEFS).isBlank).toBe(true)
  })

  it('结构体字面量拆得开', () => {
    const defs = parseTemplateDefs(BLANK_DEFS)
    expect(defs.folderRenames).toEqual([
      { from: 'Source/%TEMPLATENAME%', to: 'Source/%PROJECTNAME%' }
    ])
    expect(defs.replacementsInFiles[0]).toEqual({
      extensions: ['cpp', 'h', 'ini', 'cs'],
      from: '%TEMPLATENAME_UPPERCASE%',
      to: '%PROJECTNAME_UPPERCASE%',
      caseSensitive: true
    })
  })

  it('共享内容包连档次一起读出来', () => {
    expect(parseTemplateDefs(THIRD_PERSON_DEFS).sharedContentPacks).toEqual([
      { mountName: 'LevelPrototyping', detailLevels: ['High'] },
      { mountName: 'Characters', detailLevels: ['High'] }
    ])
  })

  it('没有 SharedContentPacks 的模板给空数组', () => {
    expect(parseTemplateDefs(BLANK_DEFS).sharedContentPacks).toEqual([])
  })
})

describe('expandPlaceholders', () => {
  it('大小写变体先于裸占位符替换 —— 顺序反了 %TEMPLATENAME_UPPERCASE% 会被切成两半', () => {
    expect(expandPlaceholders('%TEMPLATENAME_UPPERCASE%', 'TP_BlankBP', 'MyGame')).toBe(
      'TP_BLANKBP'
    )
    expect(expandPlaceholders('%PROJECTNAME_LOWERCASE%', 'TP_BlankBP', 'MyGame')).toBe('mygame')
    expect(expandPlaceholders('Source/%PROJECTNAME%', 'TP_BlankBP', 'MyGame')).toBe('Source/MyGame')
  })
})

describe('shouldSkip', () => {
  const defs = parseTemplateDefs(BLANK_DEFS)

  it('模板自己的 .uproject 不拷 —— 它的 EngineAssociation 是空的，要重新生成', () => {
    expect(shouldSkip('TP_BlankBP.uproject', defs, 'TP_BlankBP', 'MyGame')).toBe(true)
  })

  it('TemplateDefs.ini 不拷进新工程', () => {
    expect(shouldSkip('Config/TemplateDefs.ini', defs, 'TP_BlankBP', 'MyGame')).toBe(true)
  })

  it('被忽略的目录连同里面的文件一起跳过', () => {
    expect(shouldSkip('Media', defs, 'TP_BlankBP', 'MyGame')).toBe(true)
    expect(shouldSkip('Media/TP_BlankBP.png', defs, 'TP_BlankBP', 'MyGame')).toBe(true)
  })

  it('正常文件不跳过', () => {
    expect(shouldSkip('Config/DefaultEngine.ini', defs, 'TP_BlankBP', 'MyGame')).toBe(false)
    expect(shouldSkip('Content/ThirdPerson/Maps/Map.umap', defs, 'TP_BlankBP', 'MyGame')).toBe(
      false
    )
  })

  it('反斜杠路径也认 —— Windows 上遍历拼出来的就是反斜杠', () => {
    expect(shouldSkip('Config\\TemplateDefs.ini', defs, 'TP_BlankBP', 'MyGame')).toBe(true)
  })
})

describe('rewriteRelativePath', () => {
  const defs = parseTemplateDefs(BLANK_DEFS)

  it('C++ 模块目录跟着工程名改', () => {
    expect(rewriteRelativePath('Source/TP_BlankBP/Foo.cpp', defs, 'TP_BlankBP', 'MyGame')).toBe(
      'Source/MyGame/Foo.cpp'
    )
  })

  it('文件名里的模板名也跟着改，但只对声明的扩展名生效', () => {
    expect(rewriteRelativePath('Source/TP_BlankBP.Target.cs', defs, 'TP_BlankBP', 'MyGame')).toBe(
      'Source/MyGame.Target.cs'
    )
    // .umap 不在 Extensions 里 —— 资产文件名不能乱改，改了资产内部的引用就断了
    expect(rewriteRelativePath('Content/TP_BlankBP_Map.umap', defs, 'TP_BlankBP', 'MyGame')).toBe(
      'Content/TP_BlankBP_Map.umap'
    )
  })

  it('不相关的路径原样返回', () => {
    expect(rewriteRelativePath('Config/DefaultEngine.ini', defs, 'TP_BlankBP', 'MyGame')).toBe(
      'Config/DefaultEngine.ini'
    )
  })
})

describe('rewriteFileContent', () => {
  const defs = parseTemplateDefs(BLANK_DEFS)

  it('ini 里的模板名换成工程名', () => {
    const content = '[/Script/EngineSettings]\nGameName=TP_BlankBP\nUpper=TP_BLANKBP\n'
    expect(
      rewriteFileContent(content, 'Config/DefaultEngine.ini', defs, 'TP_BlankBP', 'MyGame')
    ).toBe('[/Script/EngineSettings]\nGameName=MyGame\nUpper=MYGAME\n')
  })

  it('扩展名不在清单里就一个字都不改', () => {
    const content = 'TP_BlankBP'
    expect(rewriteFileContent(content, 'Content/Foo.uasset', defs, 'TP_BlankBP', 'MyGame')).toBe(
      'TP_BlankBP'
    )
  })
})

describe('validateProjectName', () => {
  it('放行合法的名字', () => {
    expect(validateProjectName('MyGame')).toBeUndefined()
    expect(validateProjectName('_Test123')).toBeUndefined()
  })

  it('挡住中文名 —— UE 编译和打包会出问题', () => {
    expect(validateProjectName('我的工程')).toContain('不合法')
  })

  it('挡住数字开头和空格', () => {
    expect(validateProjectName('2077')).toContain('不合法')
    expect(validateProjectName('My Game')).toContain('不合法')
  })

  it('挡住超长的名字', () => {
    expect(validateProjectName('A'.repeat(21))).toContain('太长')
  })

  it('空名字有明确说法', () => {
    expect(validateProjectName('')).toContain('不能为空')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 真拷一遍：在临时目录里造一个引擎目录结构，跑完整流程
// ─────────────────────────────────────────────────────────────────────────────

describe('listEngineTemplates / instantiateEngineTemplate', () => {
  let root: string
  let engineRoot: string

  /** 造一个「引擎」：一个空白模板、一个带共享内容包的模板、两个共享包 */
  async function buildFakeEngine(): Promise<void> {
    const templates = path.join(engineRoot, 'Templates')

    const blank = path.join(templates, 'TP_BlankBP')
    await fs.mkdir(path.join(blank, 'Config'), { recursive: true })
    await fs.mkdir(path.join(blank, 'Media'), { recursive: true })
    await fs.writeFile(path.join(blank, 'Config', 'TemplateDefs.ini'), BLANK_DEFS, 'utf-8')
    await fs.writeFile(
      path.join(blank, 'Config', 'DefaultEngine.ini'),
      '[/Script/EngineSettings]\nGameName=TP_BlankBP\n',
      'utf-8'
    )
    await fs.writeFile(
      path.join(blank, 'TP_BlankBP.uproject'),
      JSON.stringify({ FileVersion: 3, EngineAssociation: '', Modules: [], Plugins: [] }),
      'utf-8'
    )
    await fs.writeFile(path.join(blank, 'Media', 'TP_BlankBP.png'), 'fake-png', 'utf-8')

    const third = path.join(templates, 'TP_ThirdPersonBP')
    await fs.mkdir(path.join(third, 'Config'), { recursive: true })
    await fs.mkdir(path.join(third, 'Content', 'ThirdPerson'), { recursive: true })
    await fs.writeFile(path.join(third, 'Config', 'TemplateDefs.ini'), THIRD_PERSON_DEFS, 'utf-8')
    await fs.writeFile(
      path.join(third, 'TP_ThirdPersonBP.uproject'),
      JSON.stringify({ FileVersion: 3, EngineAssociation: '' }),
      'utf-8'
    )
    await fs.writeFile(
      path.join(third, 'Content', 'ThirdPerson', 'BP_Char.uasset'),
      'binary-ish TP_ThirdPersonBP',
      'utf-8'
    )

    for (const pack of ['Characters', 'LevelPrototyping']) {
      const packDir = path.join(templates, 'TemplateResources', 'High', pack)
      await fs.mkdir(path.join(packDir, 'Content', 'Sub'), { recursive: true })
      await fs.mkdir(path.join(packDir, 'FeaturePack'), { recursive: true })
      await fs.writeFile(path.join(packDir, 'Content', 'Sub', 'A.uasset'), 'asset', 'utf-8')
      await fs.writeFile(
        path.join(packDir, 'FeaturePack', 'manifest.json'),
        JSON.stringify({ AdditionalFiles: { DestinationFilesFolder: pack } }),
        'utf-8'
      )
    }
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ua-engine-templates-'))
    engineRoot = path.join(root, 'UE_5.5')
    await buildFakeEngine()
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  function engines(): Array<{ version: string; rootPath: string }> {
    return [{ version: '5.5', rootPath: engineRoot }]
  }

  async function findTemplate(name: string): Promise<EngineTemplate> {
    const all = await listEngineTemplates(engines())
    const found = all.find((template) => template.templateName === name)
    if (!found) throw new Error(`用例自己的引擎目录里没有 ${name}`)
    return found
  }

  it('列出模板，带版本号的 key 和中文名', async () => {
    const templates = await listEngineTemplates(engines())
    expect(templates.map((template) => template.key)).toEqual([
      '5.5/TP_BlankBP',
      '5.5/TP_ThirdPersonBP'
    ])
    expect(templates[0].displayName).toBe('空白')
    expect(templates[0].engineVersion).toBe('5.5')
  })

  it('TemplateResources 不算模板 —— 它是共享内容包的家', async () => {
    const templates = await listEngineTemplates(engines())
    expect(templates.some((template) => template.templateName === 'TemplateResources')).toBe(false)
  })

  it('引擎目录不存在时安静返回空数组，不抛', async () => {
    await expect(
      listEngineTemplates([{ version: '9.9', rootPath: path.join(root, 'nope') }])
    ).resolves.toEqual([])
  })

  it('建出来的 .uproject 填了引擎版本 —— 空的话首页卡片上没有版本角标', async () => {
    const result = await instantiateEngineTemplate({
      template: await findTemplate('TP_BlankBP'),
      projectName: 'MyGame',
      targetDir: root
    })

    const descriptor = JSON.parse(await fs.readFile(result.uprojectPath, 'utf-8'))
    expect(descriptor.EngineAssociation).toBe('5.5')
    expect(path.basename(result.uprojectPath)).toBe('MyGame.uproject')
  })

  it('模板的忽略清单被真的执行了', async () => {
    const result = await instantiateEngineTemplate({
      template: await findTemplate('TP_BlankBP'),
      projectName: 'MyGame',
      targetDir: root
    })

    const entries = await fs.readdir(result.projectDir)
    expect(entries).not.toContain('Media')
    expect(entries).not.toContain('TP_BlankBP.uproject')
    await expect(
      fs.access(path.join(result.projectDir, 'Config', 'TemplateDefs.ini'))
    ).rejects.toThrow()
  })

  it('ini 里的模板名换成了工程名', async () => {
    const result = await instantiateEngineTemplate({
      template: await findTemplate('TP_BlankBP'),
      projectName: 'MyGame',
      targetDir: root
    })

    const ini = await fs.readFile(
      path.join(result.projectDir, 'Config', 'DefaultEngine.ini'),
      'utf-8'
    )
    expect(ini).toContain('GameName=MyGame')
    expect(ini).not.toContain('TP_BlankBP')
  })

  it('工程封面拷成 <工程名>.png —— 首页卡片靠它，不拷就是一张空白卡', async () => {
    const result = await instantiateEngineTemplate({
      template: await findTemplate('TP_BlankBP'),
      projectName: 'MyGame',
      targetDir: root
    })

    await expect(fs.access(path.join(result.projectDir, 'MyGame.png'))).resolves.toBeUndefined()
  })

  it('共享内容包落到 Content/<包名>/ —— 落错地方模板资产就是丢失引用', async () => {
    const result = await instantiateEngineTemplate({
      template: await findTemplate('TP_ThirdPersonBP'),
      projectName: 'MyShooter',
      targetDir: root
    })

    expect(result.sharedPacks.sort()).toEqual(['Characters', 'LevelPrototyping'])
    await expect(
      fs.access(path.join(result.projectDir, 'Content', 'Characters', 'Sub', 'A.uasset'))
    ).resolves.toBeUndefined()
    await expect(
      fs.access(path.join(result.projectDir, 'Content', 'LevelPrototyping', 'Sub', 'A.uasset'))
    ).resolves.toBeUndefined()
  })

  it('共享包在引擎里缺失时如实报警告，不装作没事', async () => {
    await fs.rm(path.join(engineRoot, 'Templates', 'TemplateResources', 'High', 'Characters'), {
      recursive: true,
      force: true
    })

    const result = await instantiateEngineTemplate({
      template: await findTemplate('TP_ThirdPersonBP'),
      projectName: 'MyShooter',
      targetDir: root
    })

    expect(result.sharedPacks).toEqual(['LevelPrototyping'])
    expect(result.warnings.join('\n')).toContain('Characters')
  })

  it('资产文件按二进制原样拷，内容一个字节都不改', async () => {
    const result = await instantiateEngineTemplate({
      template: await findTemplate('TP_ThirdPersonBP'),
      projectName: 'MyShooter',
      targetDir: root
    })

    const asset = await fs.readFile(
      path.join(result.projectDir, 'Content', 'ThirdPerson', 'BP_Char.uasset'),
      'utf-8'
    )
    expect(asset).toBe('binary-ish TP_ThirdPersonBP')
  })

  it('目标目录非空时拒绝，不覆盖用户已有的东西', async () => {
    const occupied = path.join(root, 'Taken')
    await fs.mkdir(occupied, { recursive: true })
    await fs.writeFile(path.join(occupied, 'keep.txt'), 'mine', 'utf-8')

    await expect(
      instantiateEngineTemplate({
        template: await findTemplate('TP_BlankBP'),
        projectName: 'Taken',
        targetDir: root
      })
    ).rejects.toThrow(/已存在且不是空的/)

    // 拒绝之后用户的文件还在
    await expect(fs.readFile(path.join(occupied, 'keep.txt'), 'utf-8')).resolves.toBe('mine')
  })

  it('非法工程名在动手拷之前就挡下来', async () => {
    await expect(
      instantiateEngineTemplate({
        template: await findTemplate('TP_BlankBP'),
        projectName: '我的工程',
        targetDir: root
      })
    ).rejects.toThrow(/不合法/)

    await expect(fs.access(path.join(root, '我的工程'))).rejects.toThrow()
  })
})
