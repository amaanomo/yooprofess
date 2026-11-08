import { useState, useEffect, useRef, useCallback } from 'react'
import CosmicStarfield from './background/CosmicStarfield.jsx'
import Astronaut from './background/Astronaut.jsx'
import PlanetGlow from './background/PlanetGlow.jsx'
import Header from './components/Header.jsx'
import TeacherPanel from './components/TeacherPanel.jsx'
import Whiteboard from './components/Whiteboard.jsx'
import CodeBoard, { ModeChooser } from './components/CodeBoard.jsx'
import Footer from './components/Footer.jsx'
import { sendToBackground } from './lib/chromeBridge.js'
import { renderUpTo } from './lib/drawShapes.js'
import { hasVoice, prefetch, setLanguage, speak, stopSpeech } from './lib/tts.js'

function readPref(key) {
  try { return localStorage.getItem(key) } catch (_) { return null }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value) } catch (_) { /* ignore */ }
}
const validPlan = (p) => !!p && Array.isArray(p.steps) && p.steps.length > 0

export default function App() {
  // === UI state (drives re-renders) ===
  const [steps, setSteps] = useState([])
  const [index, setIndex] = useState(-1)
  const [playing, setPlayingUI] = useState(true)
  const [level, setLevelUI] = useState('normal')
  const [busy, setBusyUI] = useState(false)
  const [captionText, setCaptionText] = useState('Thinking about how to draw this…')
  const [title, setTitle] = useState('Nova whiteboard')
  const [question, setQuestion] = useState('')
  const [talking, setTalking] = useState(false)
  const [muted, setMutedUI] = useState(() => readPref('nova:muted') === '1')
  const [voiceBlocked, setVoiceBlockedUI] = useState(false)
  const [statusText, setStatusText] = useState('')
  // Code walkthrough: mode is 'diagram' or 'code'; codeInfo is { code, code_language, source } when code was found.
  const [mode, setModeUI] = useState('diagram')
  const [codeInfo, setCodeInfo] = useState(null)
  const [choosing, setChoosing] = useState(false)

  // === Mutable runtime state (refs, read in async callbacks) ===
  const stepsRef = useRef([])
  const indexRef = useRef(-1)
  const playingRef = useRef(true)
  const levelRef = useRef('normal')
  const busyRef = useRef(false)
  const mutedRef = useRef(readPref('nova:muted') === '1')
  const voiceBlockedRef = useRef(false)
  const narrIdRef = useRef(0)
  const timerRef = useRef(null)
  const ctxRef = useRef(null)
  const planKeyRef = useRef('')
  const svgLayerRef = useRef(null)
  const modeRef = useRef('diagram')
  const codeRef = useRef(null)

  // Keep refs in sync with state setters
  const updateSteps = useCallback((v) => { stepsRef.current = v; setSteps(v) }, [])
  const updateIndex = useCallback((v) => { indexRef.current = v; setIndex(v) }, [])
  const updatePlaying = useCallback((v) => { playingRef.current = v; setPlayingUI(v) }, [])
  const updateLevel = useCallback((v) => { levelRef.current = v; setLevelUI(v) }, [])
  const updateBusy = useCallback((v) => { busyRef.current = v; setBusyUI(v) }, [])
  const updateMuted = useCallback((v) => { mutedRef.current = v; setMutedUI(v) }, [])
  const updateVoiceBlocked = useCallback((v) => { voiceBlockedRef.current = v; setVoiceBlockedUI(v) }, [])

  const updateMode = useCallback((v) => { modeRef.current = v; setModeUI(v) }, [])
  const cacheKey = useCallback(() => `${planKeyRef.current}:${modeRef.current}:${levelRef.current}`, [])

  /** What the backend needs for a lesson: the context (minus the frame), plus the code in code mode. */
  const lessonPayload = useCallback((extra) => {
    // eslint-disable-next-line no-unused-vars
    const { image, ...ctx } = ctxRef.current || {}
    const code = modeRef.current === 'code' && codeRef.current ? { mode: 'code', ...codeRef.current } : {}
    return { ...ctx, ...code, level: levelRef.current, ...extra }
  }, [])

  async function persist(plan) {
    try { await chrome.storage.local.set({ [cacheKey()]: plan }) } catch (_) { /* cache is optional */ }
  }

  // === Narration ===
  const stopNarration = useCallback(() => {
    narrIdRef.current++
    clearTimeout(timerRef.current)
    stopSpeech()
    setTalking(false)
  }, [])

  const voiceOn = useCallback(() => hasVoice && !mutedRef.current && !voiceBlockedRef.current, [])
  const atEnd = useCallback(() => indexRef.current >= stepsRef.current.length - 1, [])

  const startNarration = useCallback(() => {
    stopNarration()
    if (indexRef.current < 0 || !stepsRef.current[indexRef.current]) return
    const id = narrIdRef.current
    const text = stepsRef.current[indexRef.current].say || ''

    const advance = (delay) => {
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        if (id === narrIdRef.current && playingRef.current && !atEnd()) {
          showStep(indexRef.current + 1, true)
        }
      }, delay)
    }

    const timed = () => {
      setTalking(true)
      const ms = Math.max(3500, text.length * 55)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        if (id !== narrIdRef.current) return
        setTalking(false)
        if (playingRef.current && !atEnd()) showStep(indexRef.current + 1, true)
      }, ms)
    }

    if (!voiceOn()) {
      if (playingRef.current) timed()
      return
    }

    const next = stepsRef.current[indexRef.current + 1]
    if (next) prefetch(next.say)
    speak(text, {
      onStart: () => { if (id === narrIdRef.current) setTalking(true) },
      onEnd: () => {
        if (id !== narrIdRef.current) return
        setTalking(false)
        if (playingRef.current) advance(800)
      },
      onError: (e) => {
        if (id !== narrIdRef.current) return
        setTalking(false)
        if (e.error === 'canceled' || e.error === 'interrupted') return
        if (e.error === 'not-allowed') {
          updateVoiceBlocked(true)
        }
        if (playingRef.current) timed()
      },
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopNarration, voiceOn, atEnd, updateVoiceBlocked])

  // === Playback ===
  const showStep = useCallback((i, animate) => {
    const clamped = Math.max(0, Math.min(stepsRef.current.length - 1, i))
    updateIndex(clamped)
    if (modeRef.current !== 'code' && svgLayerRef.current) renderUpTo(svgLayerRef.current, stepsRef.current, clamped, animate)
    setCaptionText(stepsRef.current[clamped]?.say || '')
    // Scroll outline step into view
    const li = document.querySelector(`#outline li:nth-child(${clamped + 1})`)
    if (li) li.scrollIntoView({ block: 'nearest' })
    startNarration()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateIndex, startNarration])

  const setPlayingAndAct = useCallback((value) => {
    updatePlaying(value)
    if (value) {
      updateVoiceBlocked(false)
      if (stepsRef.current.length) startNarration()
    } else {
      stopNarration()
    }
  }, [updatePlaying, updateVoiceBlocked, startNarration, stopNarration])

  const go = useCallback((i) => {
    if (!stepsRef.current.length || busyRef.current) return
    updateVoiceBlocked(false)
    setPlayingAndAct(false)
    showStep(i, i > indexRef.current)
  }, [updateVoiceBlocked, setPlayingAndAct, showStep])

  // === Build outline ===
  const buildAndPlay = useCallback((newSteps, startIndex = 0) => {
    updateSteps(newSteps)
    updatePlaying(true)
    showStep(startIndex, true)
  }, [updateSteps, updatePlaying, showStep])

  // === Load plan ===
  const loadPlan = useCallback(async (previousLevel) => {
    const hadLesson = stepsRef.current.length > 0
    stopNarration()
    updateBusy(true)
    setStatusText(
      levelRef.current === 'simpler'
        ? 'Making it simpler…'
        : levelRef.current === 'deeper'
        ? 'Going deeper…'
        : modeRef.current === 'code'
        ? 'Nova is reading through the code…'
        : 'Nova is thinking about how to draw this…'
    )

    let plan = null
    try {
      const cached = await chrome.storage.local.get(cacheKey())
      plan = cached[cacheKey()] || null
    } catch (_) { /* ignore */ }

    if (!validPlan(plan)) {
      const res = await sendToBackground({ type: 'NOVA_EXPLAIN_PLAN', payload: lessonPayload() })
      plan = res.ok ? res.data : null
      if (validPlan(plan) && (plan.steps.length > 1 || (plan.steps[0].draw || []).length)) {
        persist(plan)
      }
    }

    updateBusy(false)

    if (!validPlan(plan)) {
      if (hadLesson) {
        updateLevel(previousLevel || 'normal')
        setStatusText('')
        setCaptionText('Sorry, I couldn\'t do that right now. Try again in a moment.')
      } else {
        setStatusText('I couldn\'t reach the Nova server to draw this. Close this tab and try again.')
        setCaptionText('Sorry, something went wrong.')
      }
      return
    }

    updateSteps(plan.steps)
    const planTitle = plan.title || 'Nova whiteboard'
    setTitle(planTitle)
    document.title = plan.title ? `${planTitle} · Nova` : 'Nova whiteboard'
    setStatusText('')
    buildAndPlay(plan.steps, 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopNarration, updateBusy, cacheKey, updateLevel, updateSteps, buildAndPlay, lessonPayload])

  // === Code walkthrough vs diagram ===
  const pickMode = useCallback((next) => {
    if (busyRef.current) return
    setChoosing(false)
    updateMode(next)
    stopNarration()
    updateSteps([])
    updateIndex(-1)
    if (svgLayerRef.current) svgLayerRef.current.replaceChildren()
    try { chrome.storage.local.set({ [planKeyRef.current + ':mode']: next }) } catch (_) { /* optional */ }
    loadPlan()
  }, [updateMode, stopNarration, updateSteps, updateIndex, loadPlan])

  /** Looks for code in the question, the answer or the video frame. Remembered per tab. */
  const detectCode = useCallback(async () => {
    const key = planKeyRef.current + ':code'
    try {
      const saved = await chrome.storage.local.get([key, planKeyRef.current + ':mode'])
      if (saved[key] !== undefined) return { info: saved[key], mode: saved[planKeyRef.current + ':mode'] }
    } catch (_) { /* ignore */ }
    setStatusText('Nova is looking at the question…')
    const { lecture_id, question, reply, image } = ctxRef.current
    const res = await sendToBackground({ type: 'NOVA_EXPLAIN_CODE', payload: { lecture_id, question, reply, image } })
    const info = res.ok && res.data && res.data.found
      ? { code: res.data.code, code_language: res.data.code_language, source: res.data.source }
      : null
    try { chrome.storage.local.set({ [key]: info }) } catch (_) { /* optional */ }
    return { info, mode: null }
  }, [])

  // === Level change ===
  const setLevel = useCallback((next) => {
    if (busyRef.current || !ctxRef.current) return
    const previous = levelRef.current
    const newLevel = levelRef.current === next ? 'normal' : next
    updateLevel(newLevel)
    loadPlan(previous)
  }, [updateLevel, loadPlan])

  // === Follow-up ask ===
  const handleAsk = useCallback(async (q) => {
    if (!stepsRef.current.length || busyRef.current) return
    stopNarration()
    updateBusy(true)
    setCaptionText('Let me think about that…')

    const res = await sendToBackground({
      type: 'NOVA_EXPLAIN_PLAN',
      payload: lessonPayload({
        followup: q,
        lesson: stepsRef.current.map(({ head, say }) => ({ head, say })),
      }),
    })
    updateBusy(false)

    const plan = res.ok ? res.data : null
    if (!validPlan(plan)) {
      setCaptionText('Sorry, I couldn\'t answer that right now. Try asking again.')
      return
    }

    const first = stepsRef.current.length
    plan.steps[0].clear = true
    const merged = stepsRef.current.concat(plan.steps)
    updateSteps(merged)
    persist({ title, steps: merged })
    updatePlaying(true)
    updateVoiceBlocked(false)
    showStep(first, true)
  }, [stopNarration, updateBusy, updateSteps, updatePlaying, updateVoiceBlocked, showStep, title, lessonPayload])

  // === Keyboard shortcuts ===
  useEffect(() => {
    const handler = (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowRight') go(indexRef.current + 1)
      else if (e.key === 'ArrowLeft') go(indexRef.current - 1)
      else if (e.key === ' ') {
        e.preventDefault()
        if (stepsRef.current.length && !busyRef.current) setPlayingAndAct(!playingRef.current)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [go, setPlayingAndAct])

  // === Cleanup on unmount ===
  useEffect(() => {
    return () => { stopNarration() }
  }, [stopNarration])

  // === Init ===
  useEffect(() => {
    async function load() {
      const key = new URLSearchParams(location.search).get('k')
      const stored = key ? await chrome.storage.local.get(key) : {}
      const ctx = stored[key]
      if (!ctx) {
        setStatusText('I lost track of what to explain. Go back to the lecture and click "Explain in depth" again.')
        return
      }
      ctxRef.current = ctx
      setLanguage(ctx.speech_lang) // lessons follow the lecture's subtitle language
      planKeyRef.current = 'nova:plan:' + key
      setQuestion(ctx.question ? `You asked: ${ctx.question}` : '')
      const { info, mode: savedMode } = await detectCode()
      codeRef.current = info
      setCodeInfo(info)
      if (!info) return loadPlan() // no code: the usual diagram lesson
      if (savedMode) { updateMode(savedMode); return loadPlan() } // this tab already chose
      setStatusText('')
      setCaptionText('Pick how you want this explained.')
      setChoosing(true)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Background layer */}
      <CosmicStarfield />
      <PlanetGlow />
      <Astronaut />

      {/* UI */}
      <Header title={title} question={question} />

      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          gap: 16,
          padding: '12px 20px',
          position: 'relative',
          zIndex: 10,
        }}
      >
        <TeacherPanel
          steps={steps}
          index={index}
          busy={busy}
          talking={talking}
          onGoTo={go}
          onAsk={handleAsk}
        />
        <Whiteboard
          svgLayerRef={svgLayerRef}
          captionText={captionText}
          statusText={statusText}
          codeView={mode === 'code' && codeInfo ? (
            <CodeBoard
              code={codeInfo.code}
              language={codeInfo.code_language}
              source={codeInfo.source}
              steps={steps}
              index={index}
              otherModeLabel="Show as a diagram instead"
              onOtherMode={() => pickMode('diagram')}
            />
          ) : null}
          overlay={
            choosing ? (
              <ModeChooser source={codeInfo?.source} onPick={pickMode} />
            ) : mode === 'diagram' && codeInfo && steps.length ? (
              <button
                type="button"
                onClick={() => pickMode('code')}
                style={{ position: 'absolute', top: 12, right: 14, zIndex: 4, background: 'rgba(19,22,41,0.85)', border: '1px solid #252a4d', borderRadius: 999, padding: '6px 12px', color: 'var(--comet)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}
              >
                Walk through the code instead
              </button>
            ) : null
          }
        />
      </main>

      <Footer
        playing={playing}
        busy={busy}
        stepsLen={steps.length}
        index={index}
        muted={muted}
        level={level}
        voiceBlocked={voiceBlocked}
        onPlay={() => !busy && steps.length && setPlayingAndAct(!playingRef.current)}
        onPrev={() => go(index - 1)}
        onNext={() => go(index + 1)}
        onReplay={() => {
          if (!steps.length || busy) return
          updateVoiceBlocked(false)
          updatePlaying(true)
          showStep(0, true)
        }}
        onVoice={() => {
          const next = !mutedRef.current
          updateMuted(next)
          updateVoiceBlocked(false)
          writePref('nova:muted', next ? '1' : '0')
          if (playingRef.current && stepsRef.current.length) startNarration()
          else stopNarration()
        }}
        onSimpler={() => setLevel('simpler')}
        onDeeper={() => setLevel('deeper')}
      />
    </div>
  )
}
