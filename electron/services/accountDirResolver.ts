import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const accountDirCache = new Map<string, string>()

const cleanAccountDirName = (dirName: string): string => {
  const trimmed = dirName.trim()
  if (!trimmed) return trimmed

  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    if (match) return match[1]
    return trimmed
  }

  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  if (suffixMatch) return suffixMatch[1]

  return trimmed
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export const resolveAccountDir = (dbPath?: string, wxid?: string): string | null => {
  if (!dbPath || !wxid) return null

  const cleanedWxid = cleanAccountDirName(wxid)
  const normalized = dbPath.replace(/[\\/]+$/, '')
  const cacheKey = `${normalized}|${cleanedWxid.toLowerCase()}`

  const cached = accountDirCache.get(cacheKey)
  if (cached && existsSync(cached)) return cached
  if (cached && !existsSync(cached)) {
    accountDirCache.delete(cacheKey)
  }

  const lowerWxid = cleanedWxid.toLowerCase()
  if (!lowerWxid.startsWith('wxid_')) {
    const direct = join(normalized, cleanedWxid)
    if (existsSync(direct) && isDirectory(direct)) {
      accountDirCache.set(cacheKey, direct)
      return direct
    }
  }

  try {
    const entries = readdirSync(normalized)
    for (const entry of entries) {
      const entryPath = join(normalized, entry)
      if (!isDirectory(entryPath)) continue

      const lowerEntry = entry.toLowerCase()
      const isExactMatch = lowerEntry === lowerWxid
      const isSuffixMatch = lowerEntry.startsWith(`${lowerWxid}_`)
      const shouldMatch = lowerWxid.startsWith('wxid_')
        ? isSuffixMatch
        : (isExactMatch || isSuffixMatch)

      if (shouldMatch) {
        accountDirCache.set(cacheKey, entryPath)
        return entryPath
      }
    }
  } catch { }

  return null
}
