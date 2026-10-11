// 逐行判定 sessionid-hits-raw.txt 里每个 sessionId 是声明还是使用 → decl-list.txt / use-list.txt。
// 运行：pnpm exec node .scratch/chat-terminology/scripts/classify.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRATCH = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = path.dirname(path.dirname(SCRATCH))

const lines = fs
  .readFileSync(path.join(SCRATCH, 'sessionid-hits-raw.txt'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
const byFile = {}
for (const l of lines) {
  const m = l.match(/^([^:]+):(\d+):(.*)$/)
  if (!m) continue
  ;(byFile[m[1]] ||= []).push({ ln: +m[2], text: m[3] })
}
function enclosingOpener(fileLines, ln, colStart) {
  let depth = 0
  for (let r = ln; r >= 0; r--) {
    const line = fileLines[r]
    const end = r === ln ? colStart : line.length
    for (let c = end - 1; c >= 0; c--) {
      const ch = line[c]
      if (ch === '}' || ch === ')' || ch === ']') depth++
      else if (ch === '{' || ch === '(' || ch === '[') {
        if (depth === 0) return ch
        depth--
      }
    }
  }
  return null
}
const decls = []
const uses = []
for (const [file, hits] of Object.entries(byFile)) {
  const fileLines = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split(/\r?\n/)
  for (const { ln, text: t } of hits) {
    const re = /\bsessionId\b/g
    let mm
    while ((mm = re.exec(t))) {
      const i = mm.index
      const before = t.slice(0, i)
      const after = t.slice(i + 9)
      const prevNS = (before.match(/(\S)\s*$/) || [])[1] || ''
      let isDecl = false
      let why = ''
      if (/\.\s*$|\?\.\s*$/.test(before) || /\$\{\s*$/.test(before)) {
        // member access .sessionId / ?.sessionId, or template ${sessionId} -> use
      } else if (/^\?\s*:/.test(after) || (/^\s*:/.test(after) && prevNS !== '?')) {
        isDecl = true
        why = 'member/field/param'
      } else if (/\b(?:const|let|var)\s+(?:\{[^{}\n]*|\[[^\]\n]*)?$/.test(before)) {
        isDecl = true
        why = 'var-decl'
      } else if (/^\s*=>/.test(after)) {
        isDecl = true
        why = 'arrow-param'
      } else if (prevNS === '(' && /^\s*\)\s*=>/.test(after)) {
        isDecl = true
        why = 'paren-arrow-param'
      } else if (/[(,{]\s*$/.test(before) && /^\s*=(?![=>])/.test(after)) {
        isDecl = true
        why = 'default-param'
      } else if (/[{,]\s*$/.test(before) && /^\s*[,}=]/.test(after)) {
        if (prevNS === '{') {
          if (!/\$\s*$/.test(before.slice(0, -1))) {
            isDecl = true
            why = 'shorthand/destr-field'
          }
        } else {
          const op = enclosingOpener(fileLines, ln - 1, i)
          if (op === '{') {
            isDecl = true
            why = 'shorthand/destr-field'
          }
        }
      } else if (/^\s*$/.test(before) && /^\s*[,}]/.test(after)) {
        const op = enclosingOpener(fileLines, ln - 1, 0)
        if (op === '{') {
          isDecl = true
          why = 'multiline-field'
        }
      }
      ;(isDecl ? decls : uses).push({ file, ln, why, text: t.trim() })
    }
  }
}
console.log('DECL:', decls.length, 'USE:', uses.length)
fs.writeFileSync(
  path.join(SCRATCH, 'decl-list.txt'),
  decls.map((d) => d.file + '|' + d.ln + '|' + d.why + '|' + d.text).join('\n') + '\n'
)
fs.writeFileSync(
  path.join(SCRATCH, 'use-list.txt'),
  uses.map((d) => d.file + '|' + d.ln + '|' + d.text).join('\n') + '\n'
)
const c = {}
for (const d of decls) c[d.why] = (c[d.why] || 0) + 1
console.log(c)
