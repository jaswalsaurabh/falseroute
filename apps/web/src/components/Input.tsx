import React, { useId } from 'react';

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
  const generatedId = useId();
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : generatedId);
  const feedbackId = `${inputId}-feedback`;

  return (
    <div className="form-field">
      {label && (
        <label htmlFor={inputId} className="form-field-label">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`input-field${error ? ' input-field-error' : ''} ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || helperText ? feedbackId : undefined}
        {...props}
      />
      {error && (
        <span id={feedbackId} className="form-field-error" role="alert">
          {error}
        </span>
      )}
      {helperText && !error && (
        <span id={feedbackId} className="form-field-helper">
          {helperText}
        </span>
      )}
    </div>
  );
};
