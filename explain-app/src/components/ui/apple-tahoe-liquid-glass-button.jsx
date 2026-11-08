import { cva } from 'class-variance-authority'
import { useRef, useId } from 'react'

// Bezier smoothing constant for Apple-style squircle corners
const SMOOTHING = 0.552284749831

function squirclePath(w, h, r) {
  r = Math.min(r, w / 2, h / 2)
  const c = r * SMOOTHING
  return [
    `M ${r} 0`,
    `L ${w - r} 0`,
    `C ${w - r + c} 0 ${w} ${r - c} ${w} ${r}`,
    `L ${w} ${h - r}`,
    `C ${w} ${h - r + c} ${w - r + c} ${h} ${w - r} ${h}`,
    `L ${r} ${h}`,
    `C ${r - c} ${h} 0 ${h - r + c} 0 ${h - r}`,
    `L 0 ${r}`,
    `C 0 ${r - c} ${r - c} 0 ${r} 0`,
    `Z`,
  ].join(' ')
}

const buttonVariants = cva(
  // base
  'relative inline-flex items-center justify-center select-none transition-all duration-150 cursor-pointer disabled:cursor-default disabled:opacity-40',
  {
    variants: {
      variant: {
        default: '',
        active: '',
        ghost: '',
      },
      size: {
        sm: 'text-xs px-3 py-1.5',
        md: 'text-sm px-4 py-2',
        lg: 'text-base px-5 py-2.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
)

export function LiquidGlassButton({
  children,
  variant = 'default',
  size = 'md',
  active = false,
  disabled = false,
  onClick,
  id,
  type = 'button',
  title,
  className = '',
  radius = 10,
  style = {},
}) {
  const resolvedVariant = active ? 'active' : variant
  const svgId = useId()
  const clipId = `lg-clip-${svgId}`
  const filterId = `lg-filter-${svgId}`

  // Sizing from size prop
  const sizeMap = { sm: { h: 30, fontSize: 12, px: 12, py: 6 }, md: { h: 36, fontSize: 13, px: 16, py: 8 }, lg: { h: 44, fontSize: 15, px: 20, py: 10 } }
  const s = sizeMap[size] || sizeMap.md

  const glassStyle = active
    ? {
        background: 'linear-gradient(135deg, rgba(124,58,237,0.75) 0%, rgba(168,85,247,0.75) 100%)',
        boxShadow: '0 2px 12px rgba(124,58,237,0.45), inset 0 1px 0 rgba(255,255,255,0.25)',
        border: '1px solid rgba(168,85,247,0.6)',
        color: '#ffffff',
      }
    : {
        background: 'rgba(255,255,255,0.07)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.15), inset 0 -1px 0 rgba(0,0,0,0.12)',
        border: '1px solid rgba(255,255,255,0.14)',
        color: '#a78bfa',
      }

  return (
    <button
      id={id}
      type={type}
      disabled={disabled}
      onClick={onClick}
      title={title}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        paddingTop: s.py,
        paddingBottom: s.py,
        paddingLeft: s.px,
        paddingRight: s.px,
        fontSize: s.fontSize,
        fontWeight: 500,
        borderRadius: radius,
        outline: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'background 0.15s, box-shadow 0.15s, transform 0.08s, opacity 0.15s',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        letterSpacing: '0.01em',
        overflow: 'hidden',
        ...glassStyle,
        ...style,
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        if (!active) {
          e.currentTarget.style.background = 'rgba(255,255,255,0.12)'
          e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.20), inset 0 -1px 0 rgba(0,0,0,0.12)'
        }
      }}
      onMouseLeave={(e) => {
        if (disabled) return
        if (!active) {
          e.currentTarget.style.background = 'rgba(255,255,255,0.07)'
          e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.15), inset 0 -1px 0 rgba(0,0,0,0.12)'
        }
      }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = 'scale(0.97)' }}
      onMouseUp={(e) => { if (!disabled) e.currentTarget.style.transform = 'scale(1)' }}
    >
      {/* Top specular highlight line — the "liquid glass" signature */}
      {!active && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: '15%',
            right: '15%',
            height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)',
            borderRadius: 1,
            pointerEvents: 'none',
          }}
        />
      )}
      {children}
    </button>
  )
}
