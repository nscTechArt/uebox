import { marked, type Token, type Tokens } from 'marked'

function tokenText(token: Token): string {
  switch (token.type) {
    case 'space':
    case 'hr':
    case 'br':
      return '\n'
    case 'def':
    case 'checkbox':
      return ''
    case 'list':
      return (token as Tokens.List).items.map(tokenText).join('\n')
    case 'table': {
      const table = token as Tokens.Table
      return [table.header, ...table.rows]
        .map((row) => row.map((cell) => cell.tokens.map(tokenText).join('')).join('，'))
        .join('\n')
    }
    case 'blockquote':
    case 'list_item':
      return (token as Tokens.Blockquote).tokens.map(tokenText).join('\n')
    case 'html':
      return (token as Tokens.HTML).text.replace(/<!--[^]*?-->|<[^>]*>/g, '')
    default:
      if ('tokens' in token && token.tokens) return token.tokens.map(tokenText).join('')
      return 'text' in token ? String(token.text) : ''
  }
}

/** Parse formatting before splitting; formatting delimiters can span sentence boundaries. */
export function speechText(markdown: string): string {
  const source = markdown.replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
  const text = marked.lexer(source, { gfm: true }).map(tokenText).join('\n')
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  }
  return text
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? raw
      const hex = entity[1].toLowerCase() === 'x'
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : raw
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim()
}
