const synth = window.speechSynthesis
export const hasVoice =
  typeof window !== 'undefined' &&
  !!window.speechSynthesis &&
  typeof window.SpeechSynthesisUtterance !== 'undefined'

export function speak(text, { onStart, onEnd, onError } = {}) {
  if (!hasVoice) return
  const u = new SpeechSynthesisUtterance(text)
  if (onStart) u.onstart = onStart
  if (onEnd) u.onend = onEnd
  if (onError) u.onerror = onError
  synth.speak(u)
}

export function stopSpeech() {
  if (hasVoice) {
    try { synth.cancel() } catch (_) { /* ignore */ }
  }
}
