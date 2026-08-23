import React from 'react';
import { X } from 'lucide-react';
import { Button } from './Button.js';

export interface ModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children }) => {
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
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--surface-modal)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-modal)',
          width: '100%',
          maxWidth: '720px',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: 'var(--elevation-modal)',
          padding: 'var(--space-unit-lg)',
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
