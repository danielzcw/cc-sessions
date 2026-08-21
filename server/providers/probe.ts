import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ProviderConfig } from '../../shared/provider.js'
import { foldGeneric, sessionIdFromFile } from './generic.js'
import { expandTilde } from './registry.js'
import { globToRegExp } from '../scanner.js'

export type ProbeResult = {
  rootExists: boolean
  matchedFiles: number
  /** 抽样解析的结果，用于在页面上确认规则是否配对 */
  samples: {
    file: string
    sessionId: string
    cwd: string | null
    title: string | null
    messageCount: number
    visibleCount: number
    preview: { role: string; kind: string; text: string }[]
  }[]
  warnings: string[]
}

/**
 * 试跑一份 provider 配置：真实读几个文件、按规则解析、把结果摘要返回。
 * 让用户在保存之前就能看出「规则有没有配对」，而不是存完发现列表全空。
 */
export async function probeProvider(cfg: ProviderConfig, limit = 3): Promise<ProbeResult> {
  const rootAbs = expandTilde(cfg.root)
  const warnings: string[] = []
  if (!fs.existsSync(rootAbs)) {
    return { rootExists: false, matchedFiles: 0, samples: [], warnings: ['根目录不存在'] }
  }

  const files = await collect(rootAbs, cfg.glob || '**/*.jsonl', 200)
  if (files.length === 0) warnings.push('根目录存在，但 glob 没匹配到任何文件')

  const samples: ProbeResult['samples'] = []
  for (const abs of files.slice(0, limit)) {
    const text = await fsp.readFile(abs, 'utf8').catch(() => '')
    const records: unknown[] = []
    for (const l of text.split('\n')) {
      const t = l.trim()
      if (!t) continue
      try { records.push(JSON.parse(t)) } catch { /* 忽略坏行 */ }
    }
    if (records.length === 0) {
      warnings.push(`${path.basename(abs)}：没有可解析的 JSON 行`)
      continue
    }
    const sid = sessionIdFromFile(cfg, abs)
    const p = foldGeneric(records, sid, cfg)
    if (p.messages.length === 0) warnings.push(`${path.basename(abs)}：规则没匹配出任何消息`)
    if (!p.cwd) warnings.push(`${path.basename(abs)}：没取到 cwd，会退回目录名分组`)
    samples.push({
      file: path.relative(rootAbs, abs),
      sessionId: sid,
      cwd: p.cwd,
      title: p.aiTitle,
      messageCount: p.messages.length,
      visibleCount: p.visibleCount,
      preview: p.messages.filter((m) => !m.meta).slice(0, 5).flatMap((m) =>
        m.blocks.slice(0, 2).map((b) => ({
          role: m.role,
          kind: b.kind,
          text: b.kind === 'text' || b.kind === 'thinking'
            ? b.text.replace(/\s+/g, ' ').slice(0, 100)
            : b.kind === 'tool' ? b.name : '',
        }))),
    })
  }
  return { rootExists: true, matchedFiles: files.length, samples, warnings: [...new Set(warnings)] }
}

/** 收集匹配文件，带上限以免误配根目录时扫全盘 */
async function collect(rootAbs: string, glob: string, cap: number): Promise<string[]> {
  const re = globToRegExp(glob)
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || out.length >= cap) return
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= cap) return
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) await walk(abs, depth + 1)
      else if (e.isFile() && re.test(path.relative(rootAbs, abs))) out.push(abs)
    }
  }
  await walk(rootAbs, 0)
  return out
}

