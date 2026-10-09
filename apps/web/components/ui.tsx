'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * A toggle that is a switch to assistive technology, not a styled checkbox (UX.md,
 * accessibility). Its accessible name includes the flag key, so a screen reader announces
 * "new-checkout, switch, on", and the state is in text as well as color.
 */
export function Switch(props: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className="switch"
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-text">{props.checked ? 'On' : 'Off'}</span>
    </button>
  );
}

/** Placeholder rows at the real row height, so nothing shifts when data lands. */
export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <ul className="rows" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="row skeleton">
          <span className="skeleton-bar" />
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------------- Toasts

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});

/** Toasts last 8 s (UX.md: the undo window). Errors are alerts; the rest are polite status. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const show = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = next.current++;
    setToasts((all) => [...all, { ...toast, id }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 8000);
  }, []);
  const dismiss = (id: number) => setToasts((all) => all.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts">
        <div role="status" aria-live="polite">
          {toasts
            .filter((t) => t.tone === 'info')
            .map((t) => (
              <ToastView key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
            ))}
        </div>
        <div role="alert">
          {toasts
            .filter((t) => t.tone === 'error')
            .map((t) => (
              <ToastView key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  return (
    <div className={`toast toast-${toast.tone}`}>
      <span>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ------------------------------------------------------------------------------- Dialog

/**
 * Focus moves into the dialog, is trapped there, and returns to the trigger on close;
 * Escape closes (UX.md, accessibility).
 */
export function Dialog(props: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [href]',
        ) ?? [],
      );
    focusables()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose.current();
      }
      if (e.key === 'Tab') {
        const items = focusables();
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);

  return (
    <div className="dialog-backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="dialog">
        <h2 id={titleId}>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

/**
 * Typed confirmation for changes that reach live users. The input is an ordinary labelled
 * text field, not a trick (UX.md).
 */
export function ConfirmDialog(props: {
  title: string;
  description: ReactNode;
  confirmText: string;
  actionLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  return (
    <Dialog title={props.title} onClose={props.onCancel}>
      <div>{props.description}</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (typed === props.confirmText) props.onConfirm();
        }}
      >
        <label htmlFor={inputId}>
          Type <code>{props.confirmText}</code> to confirm
        </label>
        <input
          id={inputId}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="danger" disabled={typed !== props.confirmText}>
            {props.actionLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ErrorState(props: { message: string; onRetry: () => void }) {
  return (
    <div className="state" role="alert">
      <p>{props.message}</p>
      <button type="button" onClick={props.onRetry}>
        Retry
      </button>
    </div>
  );
}
