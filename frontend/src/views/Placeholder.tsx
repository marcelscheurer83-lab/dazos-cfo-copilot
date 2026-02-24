type Props = { title: string }

export default function Placeholder({ title }: Props) {
  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>{title}</h1>
      <p style={{ color: 'var(--text-muted)' }}>Coming soon.</p>
    </>
  )
}
