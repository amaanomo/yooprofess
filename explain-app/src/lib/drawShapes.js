const NS = 'http://www.w3.org/2000/svg'
const BOARD_H = 62 // viewBox is 100 x 62

function el(name, attrs) {
  const node = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v)
  return node
}

const sx = (v) => Number(v) || 0
const sy = (v) => (Number(v) || 0) * (BOARD_H / 100)

export function drawShape(s, cur, animate) {
  const hl = cur ? ' hl' : ''
  const anim = cur && animate
  const lineAttrs = (extra) => ({
    stroke: '#a78bfa',
    'stroke-width': 0.25,
    fill: 'none',
    pathLength: 1,
    class: ((anim ? 'draw' + (extra || '') : '') + hl).trim(),
  })
  const fillCls = () => ((anim ? 'draw pop' : '') + hl).trim()
  const label = s.label ? String(s.label) : ''
  const fit = (width, max) =>
    Math.max(0.8, Math.min(max, (width * 0.9) / (0.55 * Math.max(1, label.length))))
  const textAttrs = (extra) => ({
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    'font-size': 1.5,
    fill: '#f0e6ff',
    class: ((anim ? 'fade' : '') + (cur ? ' hl-text' : '')).trim(),
    ...extra,
  })

  const g = el('g')
  switch (s.type) {
    case 'box': {
      const w = sx(s.w) || 20
      const h = sy(s.h) || 8
      g.append(
        el('rect', {
          ...lineAttrs(),
          class: fillCls(),
          fill: 'rgba(124,58,237,0.12)',
          x: sx(s.x),
          y: sy(s.y),
          width: w,
          height: h,
          rx: 1.2,
        })
      )
      if (label) {
        const t = el('text', textAttrs({ 'font-size': fit(w, 1.8), x: sx(s.x) + w / 2, y: sy(s.y) + h / 2 }))
        t.textContent = label
        g.append(t)
      }
      break
    }
    case 'circle': {
      const r = (sx(s.w) || 12) / 2
      g.append(
        el('circle', {
          ...lineAttrs(),
          class: fillCls(),
          fill: 'rgba(124,58,237,0.12)',
          cx: sx(s.x),
          cy: sy(s.y),
          r,
        })
      )
      if (label) {
        const t = el('text', textAttrs({ 'font-size': fit(r * 1.6, 1.8), x: sx(s.x), y: sy(s.y) }))
        t.textContent = label
        g.append(t)
      }
      break
    }
    case 'arrow':
    case 'line': {
      const to = Array.isArray(s.to) ? s.to : [sx(s.x) + 10, s.y]
      const x1 = sx(s.x), y1 = sy(s.y), x2 = sx(to[0]), y2 = sy(to[1])
      g.append(el('line', { ...lineAttrs(), x1, y1, x2, y2, stroke: '#67e8f9' }))
      if (s.type === 'arrow') {
        const a = Math.atan2(y2 - y1, x2 - x1)
        const len = 1.2
        const p = (ang) => `${x2 - len * Math.cos(a + ang)},${y2 - len * Math.sin(a + ang)}`
        g.append(
          el('polyline', {
            ...lineAttrs(' draw-late'),
            stroke: '#67e8f9',
            points: `${p(0.45)} ${x2},${y2} ${p(-0.45)}`,
          })
        )
      }
      if (label) {
        const t = el('text', textAttrs({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 1.2, 'font-size': 1.3 }))
        t.textContent = label
        g.append(t)
      }
      break
    }
    case 'text':
    default: {
      const t = el('text', textAttrs({ x: sx(s.x), y: sy(s.y), 'font-size': 1.9 }))
      t.textContent = label
      g.append(t)
    }
  }
  return g
}

function anchor(s) {
  const w = sx(s.w), h = sy(s.h)
  switch (s.type) {
    case 'box': return [sx(s.x) + (w || 20), sy(s.y)]
    case 'circle': { const r = (w || 12) / 2; return [sx(s.x) + r * 0.7, sy(s.y) - r * 0.7] }
    case 'arrow':
    case 'line': { const to = Array.isArray(s.to) ? s.to : [sx(s.x) + 10, s.y]; return [sx(to[0]), sy(to[1])] }
    default: return [sx(s.x) + String(s.label || '').length * 0.45 + 1, sy(s.y)]
  }
}

export function renderUpTo(layerEl, steps, i, animateLast) {
  if (!layerEl) return
  layerEl.replaceChildren()
  let from = 0
  for (let n = 0; n <= i; n++) if (steps[n].clear) from = n
  let last = null
  for (let n = from; n <= i; n++) {
    for (const s of steps[n].draw || []) {
      layerEl.append(drawShape(s, n === i, animateLast && n === i))
      if (n === i) last = s
    }
  }
  if (last) {
    const [px, py] = anchor(last)
    layerEl.append(el('circle', { class: 'pointer', cx: px, cy: py, r: 0.7 }))
  }
}
