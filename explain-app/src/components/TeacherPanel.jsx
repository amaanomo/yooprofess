import { LiquidGlassButton } from './ui/apple-tahoe-liquid-glass-button.jsx'

const SVG_NS = 'http://www.w3.org/2000/svg'

function AlienAvatar({ talking }) {
  return (
    <svg
      viewBox="0 0 60 60"
      fill="none"
      aria-hidden="true"
      className={talking ? 'talking' : ''}
      style={{ width: 80, height: 80, display: 'block' }}
    >
      <ellipse cx="30" cy="36" rx="19" ry="20" fill="#7ee8a2"/>
      <line x1="22" y1="17" x2="17" y2="7" stroke="#7ee8a2" strokeWidth="2.5" strokeLinecap="round"/>
      <circle cx="16" cy="5.5" r="3.5" fill="#c084fc"/>
      <circle cx="16" cy="5.5" r="1.5" fill="#f0e6ff"/>
      <line x1="38" y1="17" x2="43" y2="7" stroke="#7ee8a2" strokeWidth="2.5" strokeLinecap="round"/>
      <circle cx="44" cy="5.5" r="3.5" fill="#c084fc"/>
      <circle cx="44" cy="5.5" r="1.5" fill="#f0e6ff"/>
      <ellipse cx="22" cy="34" rx="6.5" ry="7.5" fill="white"/>
      <ellipse cx="38" cy="34" rx="6.5" ry="7.5" fill="white"/>
      <circle cx="23" cy="35" r="4" fill="#1a0533"/>
      <circle cx="39" cy="35" r="4" fill="#1a0533"/>
      <circle cx="24.5" cy="33" r="1.4" fill="white"/>
      <circle cx="40.5" cy="33" r="1.4" fill="white"/>
      <path
        id="mouth"
        d="M23 44 Q30 50 37 44"
        stroke="#2d6a4f"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
      <ellipse cx="16" cy="41" rx="3.2" ry="1.9" fill="rgba(192,132,252,0.45)"/>
      <ellipse cx="44" cy="41" rx="3.2" ry="1.9" fill="rgba(192,132,252,0.45)"/>
    </svg>
  )
}

export default function TeacherPanel({ steps, index, busy, talking, onGoTo, onAsk }) {
  function handleSubmit(e) {
    e.preventDefault()
    const q = e.target.elements['ask-input'].value.trim()
    if (q) {
      onAsk(q)
      e.target.reset()
    }
  }

  return (
    <aside
      style={{
        flex: 'none',
        width: 280,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'rgba(13,15,28,0.15)',
        border: '1px solid #252a4d',
        borderRadius: 16,
        padding: 14,
        position: 'relative',
        zIndex: 10,
      }}
    >
      {/* Avatar */}
      <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 4 }}>
        <div
          style={{
            background: 'radial-gradient(ellipse at center, rgba(124,58,237,0.35) 0%, rgba(13,15,28,0) 70%)',
            borderRadius: '50%',
            padding: 8,
          }}
        >
          <AlienAvatar talking={talking} />
        </div>
      </div>

      {/* Outline */}
      <ol
        id="outline"
        aria-label="Lesson steps"
        className="outline-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          listStyle: 'none',
          margin: 0,
          padding: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
        }}
      >
        {steps.map((s, n) => (
          <li
            key={n}
            onClick={() => onGoTo(n)}
            style={{
              display: 'flex',
              gap: 8,
              padding: '7px 10px',
              borderRadius: 10,
              fontSize: 12,
              lineHeight: 1.35,
              cursor: 'pointer',
              border: n === index ? '1px solid #67e8f9' : '1px solid #252a4d',
              background: n === index ? 'rgba(103,232,249,0.12)' : 'rgba(19,22,41,0.15)',
              color: n === index ? '#67e8f9' : 'rgba(240,230,255,0.72)',
              borderLeft: n === index ? '3px solid #67e8f9' : '1px solid #252a4d',
              transition: 'all 0.15s ease',
            }}
          >
            <span
              style={{
                flex: 'none',
                fontWeight: 700,
                color: n === index ? '#67e8f9' : '#a78bfa',
                minWidth: 18,
              }}
            >
              {n + 1}.
            </span>
            <span>{s.head || (s.say || '').slice(0, 40)}</span>
          </li>
        ))}
      </ol>

      {/* Ask form */}
      <form
        id="ask-form"
        autoComplete="off"
        onSubmit={handleSubmit}
        style={{ flex: 'none', display: 'flex', gap: 6 }}
      >
        <input
          id="ask-input"
          name="ask-input"
          type="text"
          maxLength={300}
          placeholder="Ask a follow-up…"
          disabled={busy}
          aria-label="Ask a follow-up question"
          style={{
            flex: 1,
            minWidth: 0,
            padding: '8px 10px',
            border: '1px solid #252a4d',
            borderRadius: 10,
            fontSize: 13,
            background: 'rgba(19,22,41,0.15)',
            color: '#f0e6ff',
            outline: 'none',
            caretColor: '#67e8f9',
          }}
          onFocus={(e) => { e.target.style.borderColor = '#7c3aed'; e.target.style.boxShadow = '0 0 0 2px rgba(124,58,237,0.25)' }}
          onBlur={(e) => { e.target.style.borderColor = '#252a4d'; e.target.style.boxShadow = 'none' }}
        />
        <LiquidGlassButton id="ask-btn" type="submit" disabled={busy} active size="sm">
          Ask
        </LiquidGlassButton>
      </form>
    </aside>
  )
}
