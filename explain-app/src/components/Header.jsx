export default function Header({ title, question }) {
  return (
    <header
      style={{
        flex: 'none',
        padding: '12px 24px 10px',
        background: 'rgba(13,15,28,0.45)',
        borderBottom: '1px solid #252a4d',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        position: 'relative',
        zIndex: 10,
      }}
    >
      <h1
        id="title"
        style={{
          margin: 0,
          fontSize: '17px',
          fontWeight: 300,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#f0e6ff',
        }}
      >
        {title}
      </h1>
      {question && (
        <p
          id="question"
          style={{
            margin: '3px 0 0',
            fontSize: '13px',
            color: 'rgba(240,230,255,0.55)',
            minHeight: '1em',
          }}
        >
          {question}
        </p>
      )}
    </header>
  )
}
