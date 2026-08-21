import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from '../paths.js'
import { BUILTIN_PROVIDERS } from './builtins.js'
import type { ProviderConfig } from '../../shared/provider.js'

const CONFIG_FILE = path.join(DATA_DIR, 'providers.json')

export function expandTilde(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * 配置合并策略：内置项以代码为准，只把用户改过的字段覆盖上去。
 *
 * 这样内置 provider 的规则随版本更新能自动生效（CLI 改格式时我们改代码即可），
 * 同时保留用户的开关、根目录、颜色等个人设置。
 */
const USER_OVERRIDABLE = ['enabled', 'root', 'glob', 'name', 'color', 'resumeCommand'] as const

type StoredConfig = {
  version: number
  /** 内置 provider 的用户覆盖，按 id 索引 */
  overrides: Record<string, Partial<ProviderConfig>>
  /** 用户自定义的 provider */
  custom: ProviderConfig[]
}

function emptyStore(): StoredConfig {
  return { version: 1, overrides: {}, custom: [] }
}

function readStore(): StoredConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptyStore()
    const store = emptyStore()
    if ('overrides' in parsed && parsed.overrides && typeof parsed.overrides === 'object') {
      for (const [k, v] of Object.entries(parsed.overrides)) {
        if (v && typeof v === 'object') store.overrides[k] = v
      }
    }
    if ('custom' in parsed && Array.isArray(parsed.custom)) {
      for (const c of parsed.custom) {
        const err = validateProvider(c)
        if (!err) store.custom.push(c)
        else console.warn(`[ccs] 跳过无效的自定义 provider：${err}`)
      }
    }
    return store
  } catch {
    // 文件不存在或坏了都退回默认，不能让配置问题挡住启动
    return emptyStore()
  }
}

function writeStore(store: StoredConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2) + '\n')
}

/** 校验用户提交的 provider 配置。返回错误信息，null 表示通过。 */
export function validateProvider(c: unknown): string | null {
  if (!c || typeof c !== 'object') return '不是对象'
  const need = (k: string): unknown => (k in c ? Reflect.get(c, k) : undefined)

  const id = need('id')
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) {
    return 'id 必须是 2-32 位小写字母/数字/连字符'
  }
  const name = need('name')
  if (typeof name !== 'string' || !name.trim()) return 'name 不能为空'
  const root = need('root')
  if (typeof root !== 'string' || !root.trim()) return 'root 不能为空'
  const kind = need('kind')
  if (kind !== 'generic-jsonl' && kind !== 'builtin-claude') return 'kind 只能是 generic-jsonl'
  const rules = need('rules')
  if (!Array.isArray(rules)) return 'rules 必须是数组'
  if (kind === 'generic-jsonl' && rules.length === 0) return 'rules 至少要有一条'
  for (const r of rules) {
    if (!r || typeof r !== 'object') return 'rules 里有非对象项'
    const emit = 'emit' in r ? Reflect.get(r, 'emit') : undefined
    if (!['text', 'thinking', 'tool', 'toolResult'].includes(String(emit))) {
      return `未知的 emit：${String(emit)}`
    }
  }
  const glob = need('glob')
  if (glob !== undefined && typeof glob !== 'string') return 'glob 必须是字符串'
  return null
}

/** 当前生效的全部 provider（内置 + 自定义），已应用用户覆盖 */
export function listProviders(): ProviderConfig[] {
  const store = readStore()
  const out: ProviderConfig[] = []
  for (const b of BUILTIN_PROVIDERS) {
    const ov = store.overrides[b.id] ?? {}
    const merged: ProviderConfig = { ...b }
    for (const k of USER_OVERRIDABLE) {
      const v = ov[k]
      if (v !== undefined) Reflect.set(merged, k, v)
    }
    out.push(merged)
  }
  for (const c of store.custom) out.push({ ...c, builtin: false })
  return out
}

export function getProvider(id: string): ProviderConfig | undefined {
  return listProviders().find((p) => p.id === id)
}

export function enabledProviders(): ProviderConfig[] {
  return listProviders().filter((p) => p.enabled)
}

/** 新增或更新一个 provider。内置的只落覆盖字段，自定义的整体存。 */
export function upsertProvider(cfg: ProviderConfig): void {
  const err = validateProvider(cfg)
  if (err) throw new Error(err)
  const store = readStore()
  const builtin = BUILTIN_PROVIDERS.find((b) => b.id === cfg.id)
  if (builtin) {
    const ov: Partial<ProviderConfig> = store.overrides[cfg.id] ?? {}
    for (const k of USER_OVERRIDABLE) {
      const v = cfg[k]
      if (v !== undefined && v !== builtin[k]) Reflect.set(ov, k, v)
      else Reflect.deleteProperty(ov, k)
    }
    store.overrides[cfg.id] = ov
  } else {
    const i = store.custom.findIndex((c) => c.id === cfg.id)
    if (i >= 0) store.custom[i] = cfg
    else store.custom.push(cfg)
  }
  writeStore(store)
}

/** 删除自定义 provider。内置的只能停用，不能删。 */
export function removeProvider(id: string): void {
  if (BUILTIN_PROVIDERS.some((b) => b.id === id)) {
    throw new Error('内置 provider 不能删除，可以停用')
  }
  const store = readStore()
  store.custom = store.custom.filter((c) => c.id !== id)
  writeStore(store)
}

export function setEnabled(id: string, enabled: boolean): void {
  const cur = getProvider(id)
  if (!cur) throw new Error('provider 不存在')
  upsertProvider({ ...cur, enabled })
}

export function providerConfigPath(): string {
  return CONFIG_FILE
}
