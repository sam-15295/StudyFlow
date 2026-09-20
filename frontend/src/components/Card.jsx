// A surface container. `tone` tints the left border: 'warning' or 'success'.
export default function Card({ tone, className = '', children, ...rest }) {
  const toneClass = tone ? `card-${tone}` : ''
  return (
    <div className={`card ${toneClass} ${className}`.trim()} {...rest}>
      {children}
    </div>
  )
}
