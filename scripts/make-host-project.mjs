#!/usr/bin/env node
/**
 * 生成一个最小 C++ 宿主工程，用来编译插件。
 *
 * ## 为什么需要它
 *
 * 虚幻插件不能脱离工程单独编译 —— UBT 要一个 `.uproject` 和一组 Target 规则
 * 才知道往哪个目标里编。而**每个引擎大版本都要各自的宿主工程**：
 * `.uproject` 里的 `EngineAssociation` 锁死了版本，5.5 的工程不能用 5.6 编。
 *
 * 所以出八个版本的包就需要八个工程。手工建八次是纯粹的重复劳动，
 * 而且很容易在某一个上少写一个文件、卡半天。
 *
 * ## 为什么是 C++ 工程而不是蓝图工程
 *
 * 蓝图工程没有 `Source/`，也就没有 Target 规则，UBT 会报
 * `Expecting to find a type to be declared in a target rules named 'XxxEditorTarget'`。
 * 插件本身是 C++ 模块，宿主必须也是 C++ 工程。
 *
 * 用法：
 *   node scripts/make-host-project.mjs --engine 5.0 --out <目录>
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 工程名不能带点，5.0 → UALHost50 */
const projectName = (engine) => `UALHost${engine.replace('.', '')}`

export function hostProjectFiles(engine) {
  const name = projectName(engine)
  return {
    [`${name}.uproject`]: JSON.stringify(
      {
        FileVersion: 3,
        EngineAssociation: engine,
        Category: '',
        Description: '',
        Modules: [{ Name: name, Type: 'Runtime', LoadingPhase: 'Default' }],
        Plugins: [{ Name: 'UnrealAgentLink', Enabled: true }]
      },
      null,
      2
    ),

    // Target 规则。BuildSettingsVersion / IncludeOrderVersion 用 Latest —— 写死
    // 具体版本的话每个引擎都要给不同的值，Latest 在 5.0~5.7 上都认。
    [`Source/${name}.Target.cs`]: `using UnrealBuildTool;

public class ${name}Target : TargetRules
{
\tpublic ${name}Target(TargetInfo Target) : base(Target)
\t{
\t\tType = TargetType.Game;
\t\tDefaultBuildSettings = BuildSettingsVersion.Latest;
\t\tExtraModuleNames.Add("${name}");
\t}
}
`,

    [`Source/${name}Editor.Target.cs`]: `using UnrealBuildTool;

public class ${name}EditorTarget : TargetRules
{
\tpublic ${name}EditorTarget(TargetInfo Target) : base(Target)
\t{
\t\tType = TargetType.Editor;
\t\tDefaultBuildSettings = BuildSettingsVersion.Latest;
\t\tExtraModuleNames.Add("${name}");
\t}
}
`,

    [`Source/${name}/${name}.Build.cs`]: `using UnrealBuildTool;

public class ${name} : ModuleRules
{
\tpublic ${name}(ReadOnlyTargetRules Target) : base(Target)
\t{
\t\tPCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
\t\tPublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
\t}
}
`,

    // 空模块。宿主工程本身不需要做任何事，存在的意义只是给 UBT 一个落点。
    [`Source/${name}/${name}.h`]: `#pragma once

#include "CoreMinimal.h"
`,

    [`Source/${name}/${name}.cpp`]: `#include "${name}.h"
#include "Modules/ModuleManager.h"

IMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, ${name}, "${name}");
`
  }
}

export function createHostProject(engine, outDir) {
  const name = projectName(engine)
  const root = join(outDir, name)

  for (const [rel, content] of Object.entries(hostProjectFiles(engine))) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }

  mkdirSync(join(root, 'Plugins'), { recursive: true })
  return { name, root, uproject: join(root, `${name}.uproject`) }
}

if (process.argv[1]?.endsWith('make-host-project.mjs')) {
  const argv = process.argv.slice(2)
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const engine = flag('engine')
  const out = flag('out')
  if (!engine || !out) {
    console.error('用法：--engine <版本> --out <目录>')
    process.exit(1)
  }
  if (!existsSync(out)) mkdirSync(out, { recursive: true })
  const { root, uproject } = createHostProject(engine, out)
  console.log(`✓ 宿主工程已生成：${root}`)
  console.log(`  ${uproject}`)
}
