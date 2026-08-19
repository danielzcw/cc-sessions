/** 行级 diff。给 Edit 工具的改动渲染和分支对比共用。 */

export type DiffOp = 'ctx' | 'del' | 'add'
export type DiffLine = {
  op: DiffOp
  text: string
  /** 旧文本里的行号（1 起），add 行为 null */
  oldNo: number | null
  /** 新文本里的行号（1 起），del 行为 null */
  newNo: number | null
}

/**
 * 标准 LCS 动态规划。行数上限保护：超过阈值退化为「整块替换」，
 * 否则 O(n*m) 在大文件上会把页面卡死（比较两条 500 条消息的分支时很容易触发）。
 */
const MAX_CELLS = 4_000_000

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')

  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text, i) => ({ op: 'del' as DiffOp, text, oldNo: i + 1, newNo: null })),
      ...b.map((text, i) => ({ op: 'add' as DiffOp, text, oldNo: null, newNo: i + 1 })),
    ]
  }

  // 先剥掉公共前后缀，能把绝大多数实际改动的 DP 规模压到很小
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) suf++

  const aMid = a.slice(pre, a.length - suf)
  const bMid = b.slice(pre, b.length - suf)

  const n = aMid.length
  const m = bMid.length
  // dp[i][j] = aMid[i..] 与 bMid[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aMid[i] === bMid[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  for (let k = 0; k < pre; k++) {
    out.push({ op: 'ctx', text: a[k], oldNo: k + 1, newNo: k + 1 })
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (aMid[i] === bMid[j]) {
      out.push({ op: 'ctx', text: aMid[i], oldNo: pre + i + 1, newNo: pre + j + 1 })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: 'del', text: aMid[i], oldNo: pre + i + 1, newNo: null })
      i++
    } else {
      out.push({ op: 'add', text: bMid[j], oldNo: null, newNo: pre + j + 1 })
      j++
    }
  }
  while (i < n) {
    out.push({ op: 'del', text: aMid[i], oldNo: pre + i + 1, newNo: null })
    i++
  }
  while (j < m) {
    out.push({ op: 'add', text: bMid[j], oldNo: null, newNo: pre + j + 1 })
    j++
  }

  for (let k = 0; k < suf; k++) {
    out.push({
      op: 'ctx',
      text: a[a.length - suf + k],
      oldNo: a.length - suf + k + 1,
      newNo: b.length - suf + k + 1,
    })
  }
  return out
}

/** 只保留改动附近 context 行，中间用折叠标记隔开 */
export type DiffHunk = { lines: DiffLine[]; skipped: number }

export function collapseContext(lines: DiffLine[], context = 3): DiffHunk[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op === 'ctx') continue
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true
    }
  }
  const hunks: DiffHunk[] = []
  let cur: DiffLine[] = []
  let skipped = 0
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      cur.push(lines[i])
    } else {
      if (cur.length) {
        hunks.push({ lines: cur, skipped })
        cur = []
        skipped = 0
      }
      skipped++
    }
  }
  if (cur.length) hunks.push({ lines: cur, skipped })
  return hunks
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.op === 'add') added++
    else if (l.op === 'del') removed++
  }
  return { added, removed }
}
