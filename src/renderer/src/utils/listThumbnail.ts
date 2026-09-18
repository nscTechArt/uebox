import { toLocalResourceUrl } from './localResource'

/** List images (including GIF first frames) are small; previews keep their original URL. */
export function listThumbnailUrl(url: string | undefined, revision?: number): string | undefined {
  url = toLocalResourceUrl(url)
  if (!url || !url.startsWith('local-resource:')) return url
  const path = url.split(/[?#]/)[0]
  if (/\.(mp4|m4v|webm|mov|mkv|avi)$/i.test(path)) return url
  const [base, query = ''] = url.split('#')[0].split('?')
  const params = new URLSearchParams(query)
  params.set('listThumbnail', '400')
  if (revision !== undefined) params.set('revision', String(revision))
  return `${base}?${params}`
}
