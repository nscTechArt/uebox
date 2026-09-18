/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { createPackageImportsReader, readPackageImports } from './packageImports'

describe('这个模块必须保持「只读」', () => {
  it('不碰完整资产处理器，也不碰图片管线', () => {
    const source = readFileSync(path.join(__dirname, 'packageImports.ts'), 'utf8')
    const importLines = source
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n')

    // 完整处理器会顺手把缩略图转出来存盘。只是想知道「有哪些依赖」的时候走那条路，
    // 每查一个包就在磁盘上多几张没人引用的图 —— 评审复现过，两个包多了 4 张。
    expect(importLines).not.toContain('UnrealAssetProcessor')
    expect(importLines).not.toContain('sharpLoader')
    expect(importLines).not.toContain('PathManager')
  })
})

describe('readPackageImports', () => {
  it('取出 /Game 依赖，引擎路径和自引用都不算', async () => {
    const imports = await readPackageImports('SM_Chair.uasset', {
      selfSoftPath: '/Game/Meshes/SM_Chair',
      analyze: async () => ({
        imports: {
          Imports: [
            { objectName: '/Game/Materials/M_Wood' },
            { objectName: '/Engine/Transient' },
            { objectName: '/Script/Engine' },
            { objectName: '/Game/Meshes/SM_Chair' },
            { objectName: 'StaticMesh' }
          ]
        },
        softPackageReferences: [{ assetPathName: '/Game/Textures/T_Wood.T_Wood' }]
      })
    })

    expect(imports).toEqual(['/Game/Materials/M_Wood', '/Game/Textures/T_Wood'])
  })

  it('重音、日文、韩文、emoji 的依赖路径原样保留', async () => {
    // 评审复现的回归：`fixChineseEncoding` 把「非 ASCII 且非常用汉字」一律当乱码，
    // 于是这些合法路径被改坏 —— 依赖找不到，导入却报「成功、无警告」
    const names = [
      '/Game/Textures/T_Café',
      '/Game/Textures/T_日本語',
      '/Game/Textures/T_한국어',
      '/Game/Textures/T_Ünïcödé',
      '/Game/Textures/T_Ελληνικά',
      '/Game/Textures/T_Кириллица'
    ]

    const imports = await readPackageImports('a.uasset', {
      analyze: async () => ({
        imports: { Imports: names.map((objectName) => ({ objectName })) }
      })
    })

    expect(imports).toEqual(names)
  })

  it('中文路径也照样保留', async () => {
    const imports = await readPackageImports('a.uasset', {
      analyze: async () => ({
        imports: { Imports: [{ objectName: '/Game/贴图/T_木纹' }] }
      })
    })

    expect(imports).toEqual(['/Game/贴图/T_木纹'])
  })

  it('解析成功但没有依赖，返回空数组而不是 null', async () => {
    // 这是评审复现的那一条：真解析器会把空的 imports 字段整个删掉，
    // 把「字段缺失」当成「解析失败」的话，一个完整的无依赖资产会被反复重导
    const imports = await readPackageImports('SM_Lonely.uasset', {
      analyze: async () => ({})
    })

    expect(imports).toEqual([])
    expect(imports).not.toBeNull()
  })

  it('解析器抛异常时返回 null —— 这才是「解析失败」', async () => {
    const imports = await readPackageImports('broken.uasset', {
      analyze: async () => {
        throw new Error('不是合法的 uasset')
      }
    })

    expect(imports).toBeNull()
  })

  it('解析器返回 Error 或带 stack 的结果也算失败', async () => {
    await expect(
      readPackageImports('a.uasset', { analyze: async () => new Error('bad') })
    ).resolves.toBeNull()
    await expect(
      readPackageImports('b.uasset', { analyze: async () => ({ stack: 'boom' }) })
    ).resolves.toBeNull()
  })

  it('去掉包名后面的对象名后缀（/Game/A/B.B → /Game/A/B）', async () => {
    const imports = await readPackageImports('a.uasset', {
      analyze: async () => ({
        imports: { Imports: [{ packageName: '/Game/A/B.B' }] }
      })
    })

    expect(imports).toEqual(['/Game/A/B'])
  })
})

describe('createPackageImportsReader', () => {
  it('同一个包只解析一次', async () => {
    const analyze = vi.fn(async () => ({ imports: { Imports: [] } }))
    const read = createPackageImportsReader(new Map(), { analyze })

    await read('SK_Hero.uasset')
    await read('SK_Hero.uasset')

    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('失败的结果也记住，不会反复重试同一个坏文件', async () => {
    const analyze = vi.fn(async () => {
      throw new Error('bad')
    })
    const read = createPackageImportsReader(new Map(), { analyze })

    await expect(read('broken.uasset')).resolves.toBeNull()
    await expect(read('broken.uasset')).resolves.toBeNull()

    expect(analyze).toHaveBeenCalledTimes(1)
  })
})
