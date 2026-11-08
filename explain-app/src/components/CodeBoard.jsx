import { useEffect, useRef } from 'react'

// Light syntax colors for common languages. Pure function: returns [{ text, kind }] for one line.
const KEYWORDS = new Set(
  ('and as assert async await break case catch class const continue def del do elif else except export extends false ' +
    'finally for from function global if import in is lambda let new none nonlocal not null or pass private protected ' +
    'public raise return self static super switch this throw true try typeof var void while with yield int float str ' +
    'bool list dict void boolean char double long string select from where insert update delete create table')
    .split(' ')
)
const TOKEN = /(#.*$|\/\/.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(?=\s*\()|([A-Za-z_][A-Za-z0-9_]*)/g

export function tokenize(line) {
  const out = []
  let last = 0
  for (const m of line.matchAll(TOKEN)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), kind: '' })
    const [text, comment, str, num, fn, word] = m
    let kind = ''
    if (comment) kind = 'comment'
    else if (str) kind = 'string'
    else if (num) kind = 'number'
    else if (fn) kind = KEYWORDS.has(fn.toLowerCase()) ? 'keyword' : 'fn'
    else if (word && KEYWORDS.has(word.toLowerCase())) kind = 'keyword'
    out.push({ text, kind })
    last = m.index + text.length
  }
  if (last < line.length) out.push({ text: line.slice(last), kind: '' })
  return out
}

const COLORS = { comment: '#7ee8a2', string: '#fbbf24', number: '#f9a8d4', keyword: '#c084fc', fn: '#67e8f9', '': 'inherit' }

/** Layout B: the code on the left (current lines highlighted), one explanation card per step on the right. */
export default function CodeBoard({ code, language, source, steps, index, otherModeLabel, onOtherMode }) {
  const lines = (code || '').split('\n')
  const current = steps[index]
  const [from, to] = current?.lines || [0, -1]
  const seen = new Set()
  steps.slice(0, Math.max(0, index)).forEach((s) => {
    for (let n = s.lines?.[0]; n <= s.lines?.[1]; n++) seen.add(n)
  })
  const cardsRef = useRef(null)
  const codeRef = useRef(null)

  useEffect(() => {
    cardsRef.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    codeRef.current?.querySelector('[data-hl="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [index])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14, padding: 16 }}>
      <div style={{ flex: 1.25, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--star-muted)' }}>
          <span style={{ textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 700 }}>{language || 'code'}</span>
          {source === 'screen' && <span>· Read from the video, may contain small mistakes</span>}
          {onOtherMode && (
            <button
              type="button"
              onClick={onOtherMode}
              style={{ marginLeft: 'auto', background: 'none', border: 0, color: 'var(--comet)', fontWeight: 600, cursor: 'pointer', fontSize: 12.5 }}
            >
              {otherModeLabel}
            </button>
          )}
        </div>
        <pre
          ref={codeRef}
          style={{
            flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: '12px 0',
            background: 'rgba(7,8,15,0.55)', border: '1px solid #252a4d', borderRadius: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 14, lineHeight: 1.75,
          }}
        >
          {lines.map((line, i) => {
            const n = i + 1
            const hl = n >= from && n <= to
            return (
              <div
                key={n}
                data-hl={hl ? 'true' : undefined}
                style={{
                  padding: '0 14px 0 0', whiteSpace: 'pre',
                  background: hl ? 'rgba(124,58,237,0.28)' : 'transparent',
                  boxShadow: hl ? 'inset 3px 0 0 #a78bfa' : 'none',
                  opacity: !hl && seen.has(n) ? 0.5 : 1,
                  transition: 'background 200ms ease, opacity 200ms ease',
                }}
              >
                <span style={{ display: 'inline-block', width: 40, textAlign: 'right', marginRight: 14, color: '#5b6190', userSelect: 'none' }}>{n}</span>
                {tokenize(line).map((t, j) => (
                  <span key={j} style={{ color: COLORS[t.kind] }}>{t.text}</span>
                ))}
              </div>
            )
          })}
        </pre>
      </div>
      <div ref={cardsRef} style={{ flex: 1, minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 26 }}>
        {steps.slice(0, index + 1).map((s, i) => {
          const isCurrent = i === index
          const [a, b] = s.lines || [0, 0]
          return (
            <div
              key={i}
              data-current={isCurrent ? 'true' : undefined}
              style={{
                padding: '12px 14px', borderRadius: 12, fontSize: 14, lineHeight: 1.5,
                background: isCurrent ? 'rgba(124,58,237,0.16)' : 'rgba(19,22,41,0.6)',
                border: `1px solid ${isCurrent ? '#a78bfa' : '#252a4d'}`,
                color: isCurrent ? 'var(--star)' : 'var(--star-soft)',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--comet)', marginBottom: 4 }}>
                {a === b ? `Line ${a}` : `Lines ${a}–${b}`} · {s.head}
              </div>
              {s.note || s.say}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Shown before the lesson when code was found: the student picks how to be taught. */
export function ModeChooser({ source, onPick }) {
  const where = source === 'screen' ? 'on the screen' : source === 'question' ? 'in your question' : "in Nova's answer"
  const btn = {
    padding: '14px 22px', borderRadius: 14, fontSize: 16, fontWeight: 700, cursor: 'pointer',
    border: '1px solid #252a4d', background: 'rgba(19,22,41,0.9)', color: 'var(--star)',
  }
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, padding: 24, background: 'rgba(7,8,15,0.6)', borderRadius: 14, zIndex: 5 }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>I found code {where}. How should I teach it?</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button type="button" style={{ ...btn, background: '#7c3aed', borderColor: '#7c3aed' }} onClick={() => onPick('code')}>
          Walk through the code
        </button>
        <button type="button" style={btn} onClick={() => onPick('diagram')}>
          Explain with a diagram
        </button>
      </div>
    </div>
  )
}
