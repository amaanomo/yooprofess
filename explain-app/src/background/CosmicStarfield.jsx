import { useEffect, useRef } from 'react'

export default function CosmicStarfield() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    // Mouse position for parallax
    let mouseX = window.innerWidth / 2
    let mouseY = window.innerHeight / 2
    const onMouse = (e) => { mouseX = e.clientX; mouseY = e.clientY }
    window.addEventListener('mousemove', onMouse)

    // ── Stars ──────────────────────────────────────────────────────────────
    let stars = []
    function initStars() {
      stars = Array.from({ length: 300 }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: 0.4 + Math.random() * 2.5,
        opacity: 0.5 + Math.random() * 0.5,
        speed: 0.3 + Math.random() * 0.7,
        phase: Math.random() * Math.PI * 2,
      }))
    }

    // ── Constellations ─────────────────────────────────────────────────────
    // Positions as fractions [0–1]; will be multiplied by canvas size each frame
    const CONSTELLATIONS = [
      {
        pts: [[0.12,0.18],[0.19,0.12],[0.26,0.17],[0.22,0.25],[0.14,0.27]],
        edges: [[0,1],[1,2],[2,3],[3,4],[4,0],[1,3]],
        phase: Math.random() * Math.PI * 2,
        parallax: 0.012,
      },
      {
        pts: [[0.68,0.08],[0.74,0.06],[0.80,0.11],[0.77,0.18],[0.70,0.17],[0.72,0.12]],
        edges: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,0],[5,2]],
        phase: Math.random() * Math.PI * 2,
        parallax: 0.018,
      },
      {
        pts: [[0.44,0.72],[0.50,0.67],[0.56,0.72],[0.53,0.80],[0.47,0.80]],
        edges: [[0,1],[1,2],[2,3],[3,4],[4,0]],
        phase: Math.random() * Math.PI * 2,
        parallax: 0.009,
      },
    ]

    // ── Galaxy smear ───────────────────────────────────────────────────────
    const galaxy = {
      fx: 0.28, fy: 0.38,   // fractional center
      driftX: 0.000055, driftY: 0.000025,
      angle: -0.4,
      phase: 0,
      parallax: 0.03,
    }

    // ── Space debris ───────────────────────────────────────────────────────
    let debris = []
    function initDebris() {
      debris = Array.from({ length: 14 }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: 0.05 + Math.random() * 0.15,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.008,
        size: 1.5 + Math.random() * 3.5,
        opacity: 0.07 + Math.random() * 0.16,
        sides: 3 + Math.floor(Math.random() * 3),
        parallax: 0.005 + Math.random() * 0.012,
      }))
    }

    // ── Meteors ────────────────────────────────────────────────────────────
    let meteor = null
    let nextMeteor = Date.now() + 2500 + Math.random() * 2000

    function spawnMeteor() {
      const angle = (18 + Math.random() * 28) * (Math.PI / 180)
      meteor = {
        x: Math.random() * canvas.width * 0.8,
        y: Math.random() * canvas.height * 0.3,
        angle,
        length: 130 + Math.random() * 110,
        headR: 2 + Math.random() * 2,
        duration: 550 + Math.random() * 150,
        startTime: Date.now(),
      }
    }

    // ── Resize ─────────────────────────────────────────────────────────────
    function resize() {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resize()
    initStars()
    initDebris()
    window.addEventListener('resize', () => { resize(); initStars(); initDebris() })

    // ── Draw loop ──────────────────────────────────────────────────────────
    let rafId
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const W = canvas.width, H = canvas.height
      const now = Date.now()

      // Normalized mouse offset [-1, 1]
      const mx = (mouseX / W - 0.5) * 2
      const my = (mouseY / H - 0.5) * 2

      // ── Galaxy smear ──
      galaxy.phase += 0.0004
      galaxy.fx += galaxy.driftX
      galaxy.fy += galaxy.driftY
      if (galaxy.fx > 0.65 || galaxy.fx < 0.12) galaxy.driftX *= -1
      if (galaxy.fy > 0.65 || galaxy.fy < 0.15) galaxy.driftY *= -1

      const gx = galaxy.fx * W + mx * galaxy.parallax * W
      const gy = galaxy.fy * H + my * galaxy.parallax * H

      ctx.save()
      ctx.translate(gx, gy)
      ctx.rotate(galaxy.angle + Math.sin(galaxy.phase) * 0.04)
      ctx.scale(1, 0.38) // squash into ellipse

      const pulse = 0.028 + 0.009 * Math.sin(galaxy.phase * 1.5)
      const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.22)
      gr.addColorStop(0,   `rgba(103, 232, 249, ${pulse})`)
      gr.addColorStop(0.25,`rgba(124, 58, 237,  ${pulse * 0.7})`)
      gr.addColorStop(0.55,`rgba(167, 139, 250, ${pulse * 0.3})`)
      gr.addColorStop(1,   `rgba(103, 232, 249, 0)`)
      ctx.beginPath()
      ctx.arc(0, 0, W * 0.22, 0, Math.PI * 2)
      ctx.fillStyle = gr
      ctx.fill()
      ctx.restore()

      // ── Constellations ──
      for (const c of CONSTELLATIONS) {
        c.phase += 0.003
        const ox = mx * c.parallax * W
        const oy = my * c.parallax * H
        const lineFade = 0.055 + 0.025 * Math.sin(c.phase)

        ctx.strokeStyle = `rgba(167, 139, 250, ${lineFade})`
        ctx.lineWidth = 0.6
        for (const [a, b] of c.edges) {
          ctx.beginPath()
          ctx.moveTo(c.pts[a][0] * W + ox, c.pts[a][1] * H + oy)
          ctx.lineTo(c.pts[b][0] * W + ox, c.pts[b][1] * H + oy)
          ctx.stroke()
        }
        for (const [fx, fy] of c.pts) {
          const sf = 0.55 + 0.35 * Math.sin(c.phase + fx * 10)
          ctx.beginPath()
          ctx.arc(fx * W + ox, fy * H + oy, 1.6, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(192, 132, 252, ${sf})`
          ctx.fill()
        }
      }

      // ── Stars ──
      for (const s of stars) {
        s.phase += 0.012 * s.speed
        const twinkle = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(s.phase))
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(240, 230, 255, ${(s.opacity * twinkle).toFixed(3)})`
        ctx.fill()
      }

      // ── Debris ──
      for (const d of debris) {
        d.x += d.vx
        d.y += d.vy
        d.rotation += d.rotSpeed
        if (d.x < -20) d.x = W + 20
        if (d.x > W + 20) d.x = -20
        if (d.y > H + 20) d.y = -20

        const ox = mx * d.parallax * W
        const oy = my * d.parallax * H

        ctx.save()
        ctx.translate(d.x + ox, d.y + oy)
        ctx.rotate(d.rotation)
        ctx.beginPath()
        for (let i = 0; i < d.sides; i++) {
          const a = (i / d.sides) * Math.PI * 2
          const r = d.size * (0.65 + 0.35 * Math.sin(a * 1.7 + 1))
          i === 0
            ? ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r)
            : ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r)
        }
        ctx.closePath()
        ctx.fillStyle   = `rgba(167, 139, 250, ${d.opacity})`
        ctx.strokeStyle = `rgba(103, 232, 249, ${d.opacity * 0.6})`
        ctx.lineWidth = 0.5
        ctx.fill()
        ctx.stroke()
        ctx.restore()
      }

      // ── Meteor ──
      if (!meteor && now >= nextMeteor) {
        spawnMeteor()
        nextMeteor = now + 2500 + Math.random() * 2500
      }
      if (meteor) {
        const elapsed = now - meteor.startTime
        const t = Math.min(elapsed / meteor.duration, 1)
        if (t >= 1) {
          meteor = null
        } else {
          const fade = t < 0.35 ? t / 0.35 : (1 - t) / 0.65
          const cos = Math.cos(meteor.angle), sin = Math.sin(meteor.angle)
          const hx = meteor.x + cos * meteor.length * t
          const hy = meteor.y + sin * meteor.length * t
          const tx = hx - cos * meteor.length * 0.45
          const ty = hy - sin * meteor.length * 0.45

          // Trail
          const trail = ctx.createLinearGradient(tx, ty, hx, hy)
          trail.addColorStop(0,   'rgba(103, 232, 249, 0)')
          trail.addColorStop(0.5, `rgba(103, 232, 249, ${(fade * 0.4).toFixed(3)})`)
          trail.addColorStop(1,   `rgba(255, 255, 255,  ${(fade * 0.85).toFixed(3)})`)
          ctx.beginPath()
          ctx.moveTo(tx, ty)
          ctx.lineTo(hx, hy)
          ctx.strokeStyle = trail
          ctx.lineWidth = 1.8
          ctx.stroke()

          // Glow halo
          const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, meteor.headR * 4)
          halo.addColorStop(0,   `rgba(255, 255, 255, ${(fade * 0.95).toFixed(3)})`)
          halo.addColorStop(0.3, `rgba(103, 232, 249, ${(fade * 0.6).toFixed(3)})`)
          halo.addColorStop(1,   'rgba(103, 232, 249, 0)')
          ctx.beginPath()
          ctx.arc(hx, hy, meteor.headR * 4, 0, Math.PI * 2)
          ctx.fillStyle = halo
          ctx.fill()

          // Bright core
          ctx.beginPath()
          ctx.arc(hx, hy, meteor.headR * 0.6, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(255, 255, 255, ${fade})`
          ctx.fill()
        }
      }

      rafId = requestAnimationFrame(draw)
    }

    draw()
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouse)
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
