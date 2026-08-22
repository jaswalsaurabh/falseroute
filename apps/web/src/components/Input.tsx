import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  readonly label?: string | undefined;
  readonly error?: string | undefined;
  readonly helperText?: string | undefined;
}

export const Input: React.FC<InputProps> = ({
  id,
  label,
  error,
  helperText,
  className = '',
  ...props
}) => {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-unit-xs)' }}>
      {label && (
        <label
          htmlFor={inputId}
          style={{ fontSize: 'var(--text-size-sm)', fontWeight: 500, color: 'var(--text-body)' }}
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`input-field ${className}`}
        style={error ? { borderColor: 'var(--border-danger)' } : undefined}
        {...props}
      />
      {error && (
        <span style={{ fontSize: 'var(--text-size-xs)', color: 'var(--status-danger-text)' }}>
          {error}
        </span>
      )}
      {helperText && !error && (
        <span style={{ fontSize: 'var(--text-size-xs)', color: 'var(--text-muted)' }}>
          {helperText}
        </span>
      )}
    </div>
  );
};
