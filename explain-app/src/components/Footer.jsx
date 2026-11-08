import { hasVoice } from '../lib/tts.js'

const btnBase = {
  padding: '7px 13px',
  border: '1px solid #252a4d',
  borderRadius: 10,
  background: '#1a1f38',
  color: '#a78bfa',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background 0.12s, color 0.12s',
  outline: 'none',
}

const btnActive = {
  background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
  color: '#fff',
  border: '1px solid #7c3aed',
}

const btnDisabled = {
  opacity: 0.4,
  cursor: 'default',
}

function Btn({ id, onClick, disabled, active, children, title }) {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...btnBase,
        ...(active ? btnActive : {}),
        ...(disabled ? btnDisabled : {}),
      }}
      onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = '#252a4d' }}
      onMouseLeave={(e) => { if (!disabled && !active) e.currentTarget.style.background = '#1a1f38' }}
    >
      {children}
    </button>
  )
}

export default function Footer({
  playing, busy, stepsLen, index,
  muted, level, voiceBlocked,
  onPlay, onPrev, onNext, onReplay, onVoice, onSimpler, onDeeper,
}) {
  const atEnd = index >= stepsLen - 1
  const progressText = stepsLen
    ? `Step ${index + 1} of ${stepsLen}${hasVoice && !muted && voiceBlocked ? ' · click Play to hear voice' : ''}`
    : ''

  return (
    <footer
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        padding: '10px 24px 14px',
        background: 'rgba(7,8,15,0.15)',
        borderTop: '1px solid #252a4d',
        position: 'relative',
        zIndex: 10,
      }}
    >
      <Btn id="prev" onClick={onPrev} disabled={busy || index <= 0}>◀ Back</Btn>
      <Btn id="play" onClick={onPlay} disabled={busy || !stepsLen}>
        {playing ? '⏸ Pause' : '▶ Play'}
      </Btn>
      <Btn id="next" onClick={onNext} disabled={busy || atEnd}>Next ▶</Btn>
      <Btn id="replay" onClick={onReplay} disabled={busy || !stepsLen}>↻ Replay</Btn>

      {hasVoice && (
        <Btn id="voice" onClick={onVoice} title="Read the lesson aloud">
          {muted ? '🔇 Muted' : '🔊 Voice on'}
        </Btn>
      )}

      <span style={{ width: 1, height: 20, background: '#252a4d', margin: '0 4px' }} />

      <Btn id="simpler" onClick={onSimpler} disabled={busy} active={level === 'simpler'} title="Explain it in an easier way">
        Simpler
      </Btn>
      <Btn id="deeper" onClick={onDeeper} disabled={busy} active={level === 'deeper'} title="Explain it in more depth">
        Deeper
      </Btn>

      {progressText && (
        <span
          id="progress"
          style={{ marginLeft: 'auto', color: 'rgba(240,230,255,0.42)', fontSize: 12 }}
        >
          {progressText}
        </span>
      )}
    </footer>
  )
}
