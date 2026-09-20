import { useId } from 'react'

// A labelled text field. Pass as="textarea" for multi-line input; `hint` shows small help text below.
export default function Input({ label, hint, as = 'input', className = '', ...rest }) {
  const id = useId()
  const Field = as
  return (
    <div className={`field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      <Field id={id} className="input" {...rest} />
      {hint && <p className="hint">{hint}</p>}
    </div>
  )
}
