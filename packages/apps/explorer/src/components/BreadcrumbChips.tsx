import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { IoChevronDownOutline } from 'react-icons/io5'

export type BreadcrumbMenuOption = {
  key: string
  label: string
  icon?: React.ReactNode
  onSelect: () => void
}

export type BreadcrumbMenu = {
  placeholder?: string
  options: BreadcrumbMenuOption[]
}

export type BreadcrumbChip = {
  key: string
  testId?: string
  label: string
  icon?: React.ReactNode
  to?: string
  params?: Record<string, string>
  search?: Record<string, unknown>
  menu?: BreadcrumbMenu
  current?: boolean
}

type BreadcrumbChipsProps = {
  isDark: boolean
  items: BreadcrumbChip[]
  className?: string
}

export function BreadcrumbChips({ isDark, items, className = '' }: BreadcrumbChipsProps) {
  const base =
    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60'
  const linkClasses = isDark
    ? 'border-slate-700 bg-slate-900/70 text-slate-100 hover:bg-slate-800/80'
    : 'border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50'
  const currentClasses = isDark
    ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100'
    : 'border-emerald-500/30 bg-emerald-50 text-emerald-800'
  const separatorClass = isDark ? 'text-slate-600' : 'text-slate-400'

  const menuContainerClass = isDark
    ? 'border-slate-700 bg-slate-950 text-slate-100 shadow-lg shadow-slate-900/60'
    : 'border-slate-200 bg-white text-slate-900 shadow-lg'
  const menuInputClass = isDark
    ? 'w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
  const menuOptionClass = isDark
    ? 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-slate-100 transition hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-slate-800 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
  const menuEmptyClass = isDark ? 'px-3 py-2 text-xs text-slate-400' : 'px-3 py-2 text-xs text-slate-500'

  return (
    <nav aria-label="Breadcrumb" className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {items.map((item, index) => (
        <React.Fragment key={item.key}>
          {index > 0 ? <span className={separatorClass}>/</span> : null}
          {item.menu ? (
            <BreadcrumbMenuChip
              item={item}
              isDark={isDark}
              baseClass={base}
              chipClass={item.current ? currentClasses : linkClasses}
              menuContainerClass={menuContainerClass}
              menuInputClass={menuInputClass}
              menuOptionClass={menuOptionClass}
              menuEmptyClass={menuEmptyClass}
            />
          ) : item.to ? (
            <Link
              to={item.to as any}
              params={item.params as any}
              search={item.search as any}
              className={`${base} ${item.current ? currentClasses : linkClasses}`}
              aria-current={item.current ? 'page' : undefined}
              title={item.label}
              data-testid={item.testId}
            >
              {item.icon ? <span className="text-[12px]" aria-hidden>{item.icon}</span> : null}
              <span>{item.label}</span>
            </Link>
          ) : (
            <span className={`${base} ${currentClasses}`} aria-current="page" title={item.label} data-testid={item.testId}>
              {item.icon ? <span className="text-[12px]" aria-hidden>{item.icon}</span> : null}
              <span>{item.label}</span>
            </span>
          )}
        </React.Fragment>
      ))}
    </nav>
  )
}

function BreadcrumbMenuChip({
  item,
  isDark,
  baseClass,
  chipClass,
  menuContainerClass,
  menuInputClass,
  menuOptionClass,
  menuEmptyClass,
}: {
  item: BreadcrumbChip
  isDark: boolean
  baseClass: string
  chipClass: string
  menuContainerClass: string
  menuInputClass: string
  menuOptionClass: string
  menuEmptyClass: string
}) {
  const menu = item.menu
  const detailsRef = React.useRef<HTMLDetailsElement | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')

  const options = React.useMemo(() => {
    const list = [...(menu?.options ?? [])]
    list.sort((a, b) => a.label.localeCompare(b.label))
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return list
    return list.filter((opt) => opt.label.toLowerCase().includes(trimmed))
  }, [menu?.options, query])

  const close = React.useCallback(() => {
    const details = detailsRef.current
    if (!details) return
    details.open = false
    setOpen(false)
  }, [])

  React.useEffect(() => {
    if (!open) return
    setQuery('')
    const raf = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const handlePointer = (event: MouseEvent | TouchEvent) => {
      const details = detailsRef.current
      if (!details) return
      const target = event.target
      if (target instanceof Node && details.contains(target)) return
      close()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('touchstart', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('touchstart', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [close, open])

  if (!menu) {
    return null
  }

  return (
    <details
      ref={detailsRef}
      className="relative"
      onToggle={(event) => {
        setOpen((event.currentTarget as HTMLDetailsElement).open)
      }}
    >
      <summary
        className={`${baseClass} ${chipClass} breadcrumb-summary list-none cursor-pointer select-none`}
        aria-current={item.current ? 'page' : undefined}
        title={item.label}
        data-testid={item.testId}
      >
        {item.icon ? <span className="text-[12px]" aria-hidden>{item.icon}</span> : null}
        <span>{item.label}</span>
        <IoChevronDownOutline className="text-[12px] text-slate-400" aria-hidden />
      </summary>
      <div
        className={`absolute left-0 z-50 mt-2 w-64 rounded-xl border p-2 ${menuContainerClass}`}
        role="menu"
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={menu.placeholder ?? 'Filter…'}
          className={menuInputClass}
        />
        <div className="mt-2 max-h-60 overflow-auto">
          {options.length === 0 ? (
            <div className={menuEmptyClass}>No matches</div>
          ) : (
            options.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={menuOptionClass}
                onClick={() => {
                  opt.onSelect()
                  close()
                }}
              >
                {opt.icon ? <span className="text-[12px]" aria-hidden>{opt.icon}</span> : null}
                <span className="truncate">{opt.label}</span>
              </button>
            ))
          )}
        </div>
        <div className={`mt-2 text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          Esc to close
        </div>
      </div>
    </details>
  )
}
