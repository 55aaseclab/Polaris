import { normalizeVersion } from './ast.js'

export interface SemVer {
  major: number
  minor: number
  patch: number
}

export function parseSemVer(v: string): SemVer {
  const n = normalizeVersion(v.replace(/^\^/, ''))
  const [a, b, c] = n.split('.').map(Number)
  return { major: a || 0, minor: b || 0, patch: c || 0 }
}

export function cmpSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

/** 约束：`1.2.3` 精确；`^1.2.0` 兼容主版本；`1.2` 当作 ^1.2.0 */
export function satisfies(version: string, range: string): boolean {
  const ver = parseSemVer(version)
  const r = range.trim()
  if (r.startsWith('^')) {
    const base = parseSemVer(r.slice(1))
    if (ver.major !== base.major) return false
    return cmpSemVer(ver, base) >= 0
  }
  // 若只写 major.minor 无 patch 意图：当作 ^major.minor.0
  const parts = r.replace(/^\^/, '').split('.')
  if (parts.length <= 2 && !r.includes('^')) {
    const base = parseSemVer(r)
    if (ver.major !== base.major) return false
    return cmpSemVer(ver, base) >= 0
  }
  return normalizeVersion(version) === normalizeVersion(r)
}

export function pickHighest(versions: string[]): string | undefined {
  if (!versions.length) return undefined
  return [...versions].sort((a, b) => cmpSemVer(parseSemVer(b), parseSemVer(a)))[0]
}
