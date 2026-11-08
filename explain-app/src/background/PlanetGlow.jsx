export default function PlanetGlow() {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 0,
        pointerEvents: 'none',
        width: '600px',
        height: '300px',
        background:
          'radial-gradient(ellipse at center bottom, rgba(124,58,237,0.20) 0%, rgba(103,232,249,0.06) 40%, transparent 70%)',
      }}
    />
  )
}
