import { useEffect, useRef } from 'react'

export default function CosmicStarfield() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    function resize() {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resize()
    window.addEventListener('resize', resize)

    // Create stars
    const stars = Array.from({ length: 180 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: 0.5 + Math.random() * 2,
      opacity: 0.3 + Math.random() * 0.7,
      speed: 0.3 + Math.random() * 0.7,
      phase: Math.random() * Math.PI * 2,
    }))

    // Shooting star state
    let shooting = null
    let nextShoot = Date.now() + 2500 + Math.random() * 1500

    function spawnShoot() {
      const startX = Math.random() * canvas.width
      const startY = Math.random() * (canvas.height * 0.35)
      const angle = (20 + Math.random() * 25) * (Math.PI / 180)
      const length = 80 + Math.random() * 60
      shooting = {
        x: startX,
        y: startY,
        angle,
        length,
        progress: 0,
        duration: 500,
        startTime: Date.now(),
      }
    }

    let rafId
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const now = Date.now()

      // Draw stars
      for (const s of stars) {
        s.phase += 0.012 * s.speed
        const twinkle = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(s.phase))
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(240, 230, 255, ${(s.opacity * twinkle).toFixed(3)})`
        ctx.fill()
      }

      // Shooting star
      if (!shooting && now >= nextShoot) {
        spawnShoot()
        nextShoot = now + 2500 + Math.random() * 1500
      }
      if (shooting) {
        const elapsed = now - shooting.startTime
        const t = Math.min(elapsed / shooting.duration, 1)
        if (t >= 1) {
          shooting = null
        } else {
          const fade = t < 0.5 ? t * 2 : (1 - t) * 2
          const headX = shooting.x + Math.cos(shooting.angle) * shooting.length * t
          const headY = shooting.y + Math.sin(shooting.angle) * shooting.length * t
          const tailX = headX - Math.cos(shooting.angle) * shooting.length * 0.35
          const tailY = headY - Math.sin(shooting.angle) * shooting.length * 0.35
          const grad = ctx.createLinearGradient(tailX, tailY, headX, headY)
          grad.addColorStop(0, `rgba(103, 232, 249, 0)`)
          grad.addColorStop(1, `rgba(103, 232, 249, ${(fade * 0.9).toFixed(3)})`)
          ctx.beginPath()
          ctx.moveTo(tailX, tailY)
          ctx.lineTo(headX, headY)
          ctx.strokeStyle = grad
          ctx.lineWidth = 1.5
          ctx.stroke()
        }
      }

      rafId = requestAnimationFrame(draw)
    }

    draw()
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        display: 'block',
      }}
    />
  )
}
