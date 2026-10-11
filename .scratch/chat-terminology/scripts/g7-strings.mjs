// 第 7 组一次性检索：src/main 下非测试 .ts 文件里，字符串字面量（含模板）中出现「会话|聊天」的位置。
// 注释不算。输出 file:line:[callee] text，callee 是包住该字面量的最近一层调用名（用于排除日志）。
// 运行：pnpm exec node .scratch/chat-terminology/scripts/g7-strings.mjs src/main
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.argv[2] || 'src/main'
const RE = /会话|聊天/
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name))
      out.push(p)
  }
  return out
}
function calleeName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) return n.expression.getText().slice(0, 40)
    if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return ''
  }
  return ''
}
const files = fs.statSync(root).isFile() ? [root] : walk(root, [])
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  if (!RE.test(text)) continue
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const raw = node.getText()
      if (RE.test(raw)) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
        const lines = raw.split(/\r?\n/)
        lines.forEach((l, i) => {
          if (RE.test(l))
            console.log(
              `${f.replace(/\\/g, '/')}:${start + i}:[${calleeName(node)}] ${l.trim().slice(0, 200)}`
            )
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
