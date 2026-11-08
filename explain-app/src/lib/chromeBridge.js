export function sendToBackground(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: 'unreachable' })
        else resolve(res || { ok: false, error: 'unreachable' })
      })
    } catch (_) {
      resolve({ ok: false, error: 'unreachable' })
    }
  })
}
