/**
 * 侧栏图标。
 *
 * 不用 emoji：📊 是彩色的、⚙ 是细线的、🗑 又是另一种风格，混在一列里
 * 粗细和色彩完全不统一。这里用 currentColor 的单色线性图标，跟着文字颜色走，
 * 选中态自然一致。也不引图标库 —— 五个图标不值得加依赖。
 */
export type IconName = 'chat' | 'search' | 'chart' | 'trash' | 'gear'

export function Icon({ name }: { name: IconName }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'chat':
      return (
        <svg {...common}>
          <path d="M14 9.5a2 2 0 0 1-2 2H5.5L2 14V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
        </svg>
      )
    case 'search':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
      )
    case 'chart':
      return (
        <svg {...common}>
          <path d="M2 14h12" />
          <path d="M4.5 14V8M8 14V3.5M11.5 14v-4" />
        </svg>
      )
    case 'trash':
      return (
        <svg {...common}>
          <path d="M2.5 4.5h11" />
          <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
          <path d="M4 4.5 4.6 13a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4.5" />
        </svg>
      )
    case 'gear':
      // 用滑块而不是齿轮：齿轮的齿在 14px 下会糊成一团太阳
      return (
        <svg {...common}>
          <path d="M2 4.5h5M10.5 4.5H14M2 11.5h3.5M9 11.5H14" />
          <circle cx="8.75" cy="4.5" r="1.75" />
          <circle cx="7.25" cy="11.5" r="1.75" />
        </svg>
      )
  }
}
