export default function Whiteboard({ svgLayerRef, captionText, statusText }) {
  return (
    <section
      id="board-wrap"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        background: 'rgba(13,15,28,0.12)',
        border: '1px solid #252a4d',
        borderRadius: 16,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 10,
      }}
    >
      <svg
        id="board"
        viewBox="0 0 100 62"
        preserveAspectRatio="xMidYMid meet"
        style={{ flex: 1, minHeight: 0, width: '100%' }}
      >
        <defs>
          <filter id="rough" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.12" numOctaves="2" seed="4" result="noise"/>
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.45"/>
          </filter>
        </defs>
        <g id="layer" ref={svgLayerRef} filter="url(#rough)"></g>
      </svg>

      {/* Caption bubble */}
      <div
        id="bubble"
        role="status"
        aria-live="polite"
        style={{
          flex: 'none',
          width: '100%',
          background: 'rgba(19,22,41,0.20)',
          borderTop: '1px solid #252a4d',
          borderRadius: '0 0 14px 14px',
          padding: '14px 20px',
          fontSize: 17,
          lineHeight: 1.5,
          color: 'rgba(240,230,255,0.72)',
          maxHeight: '26vh',
          overflowY: 'auto',
        }}
      >
        {captionText}
      </div>

      {/* Status overlay */}
      {statusText && (
        <div
          id="status"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: 24,
            background: 'rgba(7,8,15,0.55)',
            borderRadius: 14,
            fontSize: 15,
            color: 'rgba(240,230,255,0.72)',
          }}
        >
          {statusText}
        </div>
      )}
    </section>
  )
}
