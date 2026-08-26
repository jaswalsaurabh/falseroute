import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button.js';

export interface ModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, className, children }) => {
  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'var(--surface-backdrop)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 'var(--layer-modal)',
        padding: 'var(--space-unit-md)',
        overscrollBehavior: 'contain',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal-panel${className ? ` ${className}` : ''}`}
        style={{
          backgroundColor: 'var(--surface-modal)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-modal)',
          width: '100%',
          maxWidth: '720px',
          maxHeight: '90vh',
          overflowY: className ? 'hidden' : 'auto',
          boxShadow: 'var(--elevation-modal)',
          padding: className ? 0 : 'var(--space-unit-lg)',
          display: className ? 'flex' : undefined,
          flexDirection: className ? 'column' : undefined,
          minHeight: className ? 0 : undefined,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-unit-lg)',
            borderBottom: '1px solid var(--border-subtle)',
            paddingBottom: 'var(--space-unit-sm)',
          }}
        >
          <h2
            id="modal-title"
            style={{ fontSize: 'var(--text-size-xl)', color: 'var(--text-main)' }}
          >
            {title}
          </h2>
          <Button variant="secondary" onClick={onClose} aria-label="Close dialog">
            <X size={18} aria-hidden="true" />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
};
