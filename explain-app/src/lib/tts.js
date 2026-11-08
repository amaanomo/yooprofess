// Professor Nova's narration voice.
// English lessons: ElevenLabs (through the Nova server) when background.js says it's available,
// streamed so each step starts quickly; the next step is prefetched. Lessons in other languages
// (the lecture's subtitle language), and any failure, use the browser's voice for that language.
import '../../../extension/eleven-audio.js' // defines globalThis.NovaElevenAudio
import { sendToBackground } from './chromeBridge.js'

const synth = window.speechSynthesis
const hasWebSpeech =
  typeof window !== 'undefined' &&
  !!window.speechSynthesis &&
  typeof window.SpeechSynthesisUtterance !== 'undefined'
const inExtension = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id)

export const hasVoice = hasWebSpeech || inExtension

const eleven = () => globalThis.NovaElevenAudio

// The lesson's language (BCP-47, e.g. "es-ES"); empty = English. Set from the lecture's subtitle language.
let lessonLang = ''
const baseLang = () => (lessonLang.split('-')[0] || 'en').toLowerCase()
export function setLanguage(speechLang) {
  lessonLang = String(speechLang || '')
}

// Resolves to { voiceId, base } when ElevenLabs narrates (English lessons only), else null. Asked once per page.
let enginePromise = null
function engine() {
  if (!enginePromise) {
    enginePromise =
      inExtension && eleven() && baseLang() === 'en'
        ? sendToBackground({ type: 'NOVA_GET_VOICE_ENGINE' }).then((r) =>
            r && r.ok && r.engine === 'elevenlabs'
              ? { voiceId: r.voiceId || '', base: String(r.backendUrl).replace(/\/+$/, '') }
              : null
          )
        : Promise.resolve(null)
  }
  return enginePromise
}

function useBrowserVoiceFromNowOn() {
  enginePromise = Promise.resolve(null)
  sendToBackground({ type: 'NOVA_ELEVEN_FAILED' })
}

const body = (text, e) => ({ text, voice_id: e.voiceId, language_code: 'en' })

const prefetched = new Map() // text -> Promise<Blob | null>, oldest first
const PREFETCH_MAX = 6

/** Start fetching a step's audio before it's needed, so steps follow each other without a gap. */
export function prefetch(text) {
  const clean = String(text || '').trim()
  if (!clean || prefetched.has(clean)) return
  const p = engine()
    .then((e) => (e ? eleven().fetchBlob(e.base + '/tts', body(clean, e)) : null))
    .catch(() => null)
  prefetched.set(clean, p)
  while (prefetched.size > PREFETCH_MAX) prefetched.delete(prefetched.keys().next().value)
}

let current = null // ElevenLabs player
let generation = 0

function speakWithBrowser(text, { onStart, onEnd, onError }) {
  if (!hasWebSpeech) {
    if (onError) onError({ error: 'unavailable' })
    return
  }
  const u = new SpeechSynthesisUtterance(text)
  if (lessonLang) {
    u.lang = lessonLang
    const base = baseLang()
    const voices = synth.getVoices().filter((v) => String(v.lang).toLowerCase().replace('_', '-').split('-')[0] === base)
    const voice = voices.find((v) => /premium|enhanced|natural|neural|google/i.test(v.name)) || voices[0]
    if (voice) u.voice = voice
  }
  if (onStart) u.onstart = onStart
  if (onEnd) u.onend = onEnd
  if (onError) u.onerror = onError
  synth.speak(u)
}

export function speak(text, callbacks = {}) {
  if (!hasVoice) return
  stopSpeech()
  const clean = String(text || '').trim()
  const mine = ++generation
  engine().then(async (e) => {
    if (mine !== generation) return
    if (!e) return speakWithBrowser(clean, callbacks)
    const blob = prefetched.has(clean) ? await prefetched.get(clean) : null
    if (mine !== generation) return
    current = eleven().play({
      blob: blob || undefined,
      url: e.base + '/tts/stream',
      body: body(clean, e),
      onstart: callbacks.onStart,
      onend: callbacks.onEnd,
      onerror: (err) => {
        if (err.error === 'interrupted' || err.error === 'not-allowed') {
          if (callbacks.onError) callbacks.onError(err)
          return
        }
        console.warn('[Nova] ElevenLabs narration failed, using the browser voice', err.message || err.error)
        useBrowserVoiceFromNowOn()
        if (mine === generation) speakWithBrowser(clean, callbacks)
      },
    })
  })
}

export function stopSpeech() {
  generation++
  if (current) {
    current.stop()
    current = null
  }
  if (hasWebSpeech) {
    try { synth.cancel() } catch (_) { /* ignore */ }
  }
}
