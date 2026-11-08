import { useEffect } from 'react'
import { motion, useMotionValue, useTransform } from 'framer-motion'

export default function Astronaut() {
  const mouseX = useMotionValue(typeof window !== 'undefined' ? window.innerWidth / 2 : 960)
  const mouseY = useMotionValue(typeof window !== 'undefined' ? window.innerHeight / 2 : 540)

  useEffect(() => {
    const handle = (e) => {
      mouseX.set(e.clientX)
      mouseY.set(e.clientY)
    }
    window.addEventListener('mousemove', handle)
    return () => window.removeEventListener('mousemove', handle)
  }, [mouseX, mouseY])

  const parallaxX = useTransform(mouseX, [0, 1920], [-12, 12])
  const parallaxY = useTransform(mouseY, [0, 1080], [-8, 8])

  return (
    <motion.div
      style={{
        position: 'fixed',
        bottom: '15%',
        right: '5%',
        zIndex: 1,
        pointerEvents: 'none',
        x: parallaxX,
        y: parallaxY,
      }}
    >
      <motion.div
        animate={{ y: [0, -10, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      >
        <svg
          width="100"
          height="130"
          viewBox="0 0 100 130"
          fill="none"
          aria-hidden="true"
        >
          {/* Life-support pack */}
          <rect x="62" y="48" width="14" height="20" rx="4" fill="#252a4d" stroke="#a78bfa" strokeWidth="1.5"/>
          <rect x="65" y="52" width="8" height="3" rx="1" fill="#67e8f9" opacity="0.7"/>
          <rect x="65" y="58" width="8" height="3" rx="1" fill="#c084fc" opacity="0.7"/>

          {/* Suit body */}
          <ellipse cx="45" cy="68" rx="22" ry="26" fill="#e8eaf0" stroke="#a78bfa" strokeWidth="1.5"/>

          {/* Left arm */}
          <ellipse cx="20" cy="68" rx="7" ry="13" fill="#e8eaf0" stroke="#a78bfa" strokeWidth="1.5"/>
          {/* Left glove */}
          <ellipse cx="20" cy="82" rx="7" ry="6" fill="#c084fc" stroke="#a78bfa" strokeWidth="1"/>

          {/* Right arm */}
          <ellipse cx="70" cy="68" rx="7" ry="13" fill="#e8eaf0" stroke="#a78bfa" strokeWidth="1.5"/>
          {/* Right glove */}
          <ellipse cx="70" cy="82" rx="7" ry="6" fill="#c084fc" stroke="#a78bfa" strokeWidth="1"/>

          {/* Left foot */}
          <ellipse cx="34" cy="96" rx="9" ry="5" fill="#252a4d" stroke="#a78bfa" strokeWidth="1"/>
          {/* Right foot */}
          <ellipse cx="56" cy="96" rx="9" ry="5" fill="#252a4d" stroke="#a78bfa" strokeWidth="1"/>

          {/* Helmet */}
          <circle cx="45" cy="38" r="22" fill="#252a4d" stroke="#a78bfa" strokeWidth="2"/>
          {/* Visor */}
          <ellipse cx="45" cy="40" rx="15" ry="14" fill="#0d0f1c" opacity="0.9"/>
          {/* Visor reflection strip */}
          <ellipse cx="41" cy="34" rx="6" ry="3" fill="#67e8f9" opacity="0.25" transform="rotate(-20 41 34)"/>
          {/* Visor shine dot */}
          <circle cx="52" cy="32" r="2" fill="#67e8f9" opacity="0.4"/>

          {/* Helmet ring */}
          <circle cx="45" cy="38" r="22" fill="none" stroke="#67e8f9" strokeWidth="0.8" opacity="0.4"/>

          {/* Chest detail */}
          <rect x="37" y="62" width="16" height="10" rx="3" fill="#131629" stroke="#252a4d" strokeWidth="1"/>
          <circle cx="45" cy="67" r="3" fill="#7c3aed" opacity="0.8"/>
        </svg>
      </motion.div>
    </motion.div>
  )
}
