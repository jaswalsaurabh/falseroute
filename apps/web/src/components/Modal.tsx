import React, { useEffect, useId, useRef } from 'react';
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
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;

    triggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const panel = panelRef.current;
    const focusableSelector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusTimer = window.setTimeout(
      () => panel?.querySelector<HTMLElement>(focusableSelector)?.focus(),
      0,
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => !element.hasAttribute('disabled'),
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
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
        ref={panelRef}
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
          <h2 id={titleId} style={{ fontSize: 'var(--text-size-xl)', color: 'var(--text-main)' }}>
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
