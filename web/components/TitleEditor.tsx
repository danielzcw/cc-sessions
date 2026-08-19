import { useEffect, useRef, useState } from 'react'

/**
 * 内联改名输入框。回车提交、Esc 取消、失焦提交。
 * 提交空串表示清除自定义标题，回落到 AI 生成的标题。
 */
export function TitleEditor({
  initial, placeholder, onSubmit, onCancel, className,
}: {
  initial: string
  placeholder?: string
  onSubmit: (title: string) => void
  onCancel: () => void
  className?: string
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  // 用 ref 记住是否已经收尾，避免提交后 blur 再触发一次
  const doneRef = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (commit: boolean) => {
    if (doneRef.current) return
    doneRef.current = true
    if (commit) onSubmit(value.trim())
    else onCancel()
  }

  return (
    <input
      ref={ref}
      className={`title-editor${className ? ' ' + className : ''}`}
      value={value}
      placeholder={placeholder ?? '输入新标题，留空恢复默认'}
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); finish(true) }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
      }}
      onBlur={() => finish(true)}
    />
  )
}
