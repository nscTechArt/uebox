import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { rankProjectSearch } from '@renderer/utils/projectSearch'

describe('project section final display order', () => {
  it('does not overwrite relevance with persisted manual order or pinning', () => {
    const source = parse(
      readFileSync('src/renderer/src/views/Home/components/Project/ProjectSection.vue', 'utf8')
    ).descriptor.scriptSetup!.content
    const ast = ts.createSourceFile('project.ts', source, ts.ScriptTarget.Latest, true)
    const declaration = ast.statements.find(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (item) => item.name.getText(ast) === 'visibleProjects'
        )
    )!
    const code = ts.transpileModule(declaration.getText(ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText
    const baseProjects = ref([
      { projectKey: 'name', projectName: 'RealBiomesDesert' },
      {
        projectKey: 'path',
        projectName: 'UALHost55',
        projectPath: 'H:/UnrealAgent/UALHost55',
        isPinned: 1
      }
    ])
    const keyword = ref('real')
    const visible = new Function(
      'computed',
      'baseProjects',
      'sortedProjectKeys',
      'keyword',
      'rankProjectSearch',
      code + '; return visibleProjects;'
    )(computed, baseProjects, ref(['path', 'name']), keyword, rankProjectSearch)
    expect(visible.value.map((p: ProjectRecord) => p.projectKey)).toEqual(['name', 'path'])
    keyword.value = ''
    expect(visible.value.map((p: ProjectRecord) => p.projectKey)).toEqual(['path', 'name'])
  })
})
