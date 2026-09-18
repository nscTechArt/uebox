import { describe, expect, it } from 'vitest'

// 第三方解析器是 vendored 的 JS，没有类型声明
import { ReaderUasset } from './uasset-reader-new'

/**
 * `FObjectImport::PackageName` 是 UE 4.26（VER_UE4_NON_OUTER_PACKAGE_IMPORT = 520）才加进
 * 包格式的字段，更早的包里**根本没有这几个字节**。
 *
 * 曾经的做法是版本不够就不赋值，于是 `packageNameIndex` 保持初值 0，`packageName`
 * 被解成名字表的第 0 项 —— 那是个跟依赖毫无关系的名字（常常是包自己的名字，而且
 * 少了 FName 的数字后缀）。上层把 `packageName` 当硬依赖收下，于是每个老包都凭空
 * 多出一条指向不存在文件的依赖，导入时整组资产被判「缺少依赖」拒收。
 */
const buildImportTable = (entries: number[][]): number[] => {
  const bytes: number[] = []
  for (const entry of entries) {
    for (const value of entry) {
      bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff)
    }
  }
  return bytes
}

const readImportsWith = (
  fileVersionUE4: number,
  entry: number[]
): Array<Record<string, unknown>> => {
  const reader = new ReaderUasset()
  reader.useLittleEndian = true
  reader.saveHexView = false
  reader.bytes = buildImportTable([entry])
  reader.uasset.names = [
    { Name: '/Game/Pack/Materials/M_Foo' },
    { Name: '/Script/CoreUObject' },
    { Name: 'Package' },
    { Name: '/Game/Pack/Textures/T_Bar' }
  ]
  reader.uasset.header = {
    ImportCount: 1,
    ImportOffset: 0,
    FileVersionUE4: fileVersionUE4,
    FileVersionUE5: 0
  }
  reader.readImports()

  return reader.uasset.imports.Imports
}

describe('ReaderUasset.readImports', () => {
  it('UE 4.25 及更早的包不带 PackageName 字段时，packageName 必须为空', () => {
    // classPackage, classPackageNumber, className, classNameNumber, outer, objectName, objectNameNumber
    const [imported] = readImportsWith(518, [1, 0, 2, 0, 0, 3, 0])

    expect(imported.objectName).toBe('/Game/Pack/Textures/T_Bar')
    // 关键：不能退化成名字表第 0 项 '/Game/Pack/Materials/M_Foo'
    expect(imported.packageName).toBe('')
  })

  it('UE 4.26 及以后的包仍然照常读 PackageName', () => {
    const [imported] = readImportsWith(520, [1, 0, 2, 0, 0, 3, 0, 0, 0])

    expect(imported.objectName).toBe('/Game/Pack/Textures/T_Bar')
    expect(imported.packageName).toBe('/Game/Pack/Materials/M_Foo')
  })

  it('FName 的数字后缀照常还原', () => {
    // objectNameNumber = 2 → 名字 'T_Bar' + '_1'
    const [imported] = readImportsWith(518, [1, 0, 2, 0, 0, 3, 2])

    expect(imported.objectName).toBe('/Game/Pack/Textures/T_Bar_1')
  })
})

describe('ReaderUasset.readExports', () => {
  /**
   * 导出表的 objectName 同样是 nameIndex + number 两个 int32。曾经当成一个 uint64
   * 读，number 非 0 时那个数会超过 40 亿，查名字表必然落空 —— `M_Foo_10` 这种带
   * 数字后缀的资产，对象名就读成了空串。
   */
  const readExportsWith = (entry: number[]): Array<Record<string, unknown>> => {
    const reader = new ReaderUasset()
    reader.useLittleEndian = true
    reader.saveHexView = false
    // 后面还有一串我们不关心的字段（flags / serialSize / packageGuid …），
    // 补足 0 让它们读到合法的零值，否则 fguidString 会读到 undefined 直接抛
    reader.bytes = buildImportTable([entry, new Array(32).fill(0)])
    reader.uasset.names = [
      { Name: '/Game/Pack/Materials/M_Foo' },
      { Name: '/Script/CoreUObject' },
      { Name: 'Package' },
      { Name: 'T_Bar' }
    ]
    // 518 ≥ VER_UE4_TEMPLATEINDEX_IN_COOKED_EXPORTS(508)，所以 templateIndex 也要占一格
    reader.uasset.header = {
      ExportCount: 1,
      ExportOffset: 0,
      FileVersionUE4: 518,
      FileVersionUE5: 0
    }
    reader.readExports()

    return reader.uasset.exports
  }

  it('带 _数字 后缀的导出对象名不能读成空串', () => {
    // classIndex, superIndex, templateIndex, outerIndex, objectNameIndex, objectNameNumber
    const [exported] = readExportsWith([-1, 0, 0, 0, 3, 11])

    expect(exported.objectName).toBe('T_Bar_10')
  })

  it('没有数字后缀时原样返回', () => {
    const [exported] = readExportsWith([-1, 0, 0, 0, 3, 0])

    expect(exported.objectName).toBe('T_Bar')
  })
})
