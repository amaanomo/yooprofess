import { hasVoice } from '../lib/tts.js'
import { LiquidGlassButton } from './ui/apple-tahoe-liquid-glass-button.jsx'

function Btn({ id, onClick, disabled, active, children, title }) {
  return (
    <LiquidGlassButton id={id} onClick={onClick} disabled={disabled} active={active} title={title} size="sm">
      {children}
    </LiquidGlassButton>
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
