// variant: 'primary' (accent), 'secondary' (outlined) or 'danger' (text-only, for destructive actions)
export default function Button({ variant = 'primary', type = 'button', className = '', children, ...rest }) {
  return (
    <button type={type} className={`btn btn-${variant} ${className}`.trim()} {...rest}>
      {children}
    </button>
  )
}
