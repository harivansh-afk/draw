import clsx from "clsx";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { CloseIcon } from "@excalidraw/excalidraw/components/icons";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outlined" | "ghost" | "danger" | "danger-outline";
  size?: "medium" | "large";
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  /** keyboard shortcut shown after the label, e.g. "n" or "g t" */
  hint?: string;
  busy?: boolean;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "outlined",
      size = "medium",
      icon,
      trailing,
      hint,
      busy,
      className,
      children,
      disabled,
      ...rest
    },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      className={clsx(
        "dash-button",
        `dash-button--${variant}`,
        `dash-button--${size}`,
        { "dash-button--busy": busy, "dash-button--icon-only": !children },
        className,
      )}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? (
        <Spinner />
      ) : (
        icon && <span className="dash-button__icon">{icon}</span>
      )}
      {children && <span className="dash-button__label">{children}</span>}
      {hint && <Kbd keys={hint} />}
      {trailing}
    </button>
  ),
);

/** A shortcut chip. Sequences are space separated ("g t"), chords use "+". */
export const Kbd = ({ keys }: { keys: string }) => (
  <kbd className="dash-kbd">
    {keys.split(" ").map((key, index) => (
      <span key={index} className="dash-kbd__key">
        {key}
      </span>
    ))}
  </kbd>
);

export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }
>(({ label, className, children, ...rest }, ref) => (
  <button
    ref={ref}
    type="button"
    className={clsx("dash-icon-button", className)}
    aria-label={label}
    title={label}
    {...rest}
  >
    {children}
  </button>
));

export const Spinner = () => (
  <span className="dash-spinner" role="progressbar" aria-label="Loading" />
);

// ---------------------------------------------------------------------------
// TextInput
// ---------------------------------------------------------------------------

type TextInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
};

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(
  ({ label, icon, trailing, className, id, ...rest }, ref) => {
    const generated = useId();
    const inputId = id || generated;
    return (
      <div className={clsx("dash-field", className)}>
        {label && (
          <label className="dash-field__label" htmlFor={inputId}>
            {label}
          </label>
        )}
        <div
          className={clsx("dash-field__control", {
            "dash-field__control--with-icon": !!icon,
            "dash-field__control--readonly": rest.readOnly,
          })}
        >
          {icon && <span className="dash-field__icon">{icon}</span>}
          <input ref={ref} id={inputId} {...rest} />
          {trailing}
        </div>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Menu: anchored popover, closes on outside pointer, Escape, or selection.
// The only listeners are scoped to the open menu (no global key handlers).
// ---------------------------------------------------------------------------

type MenuItemSpec =
  | {
      kind?: "item";
      label: string;
      icon?: React.ReactNode;
      onSelect: () => void;
      danger?: boolean;
      href?: string;
      disabled?: boolean;
      selected?: boolean;
      hint?: string;
    }
  | { kind: "separator" }
  | { kind: "heading"; label: string };

export type MenuItem = MenuItemSpec;

export const Menu = ({
  anchor,
  items,
  onClose,
  align = "end",
  minWidth,
}: {
  anchor: HTMLElement | null;
  items: MenuItem[];
  onClose: () => void;
  align?: "start" | "end";
  minWidth?: number;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    placeAbove: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) {
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const menu = ref.current.getBoundingClientRect();
    const margin = 6;
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove =
      spaceBelow < menu.height + margin && rect.top > menu.height;
    const top = placeAbove
      ? rect.top - menu.height - margin
      : rect.bottom + margin;
    let left = align === "end" ? rect.right - menu.width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - menu.width - 8));
    setPosition({ top, left, placeAbove });
  }, [anchor, align, items.length]);

  useEffect(() => {
    if (!anchor) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) {
        return;
      }
      onClose();
    };
    const onResize = () => onClose();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [anchor, onClose]);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(
      "[role=menuitem]:not([aria-disabled=true])",
    );
    first?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const focusable = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        "[role=menuitem]:not([aria-disabled=true])",
      ) || [],
    );
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        anchor?.focus();
        break;
      case "ArrowDown":
        event.preventDefault();
        focusable[(index + 1) % focusable.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        focusable[(index - 1 + focusable.length) % focusable.length]?.focus();
        break;
      case "Home":
        event.preventDefault();
        focusable[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        focusable[focusable.length - 1]?.focus();
        break;
      case "Tab":
        onClose();
        break;
      default:
    }
  };

  if (!anchor) {
    return null;
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className={clsx("dash-portal dash-menu", {
        "dash-menu--above": position?.placeAbove,
        "dash-menu--measuring": !position,
      })}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        minWidth,
      }}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => {
        if (item.kind === "separator") {
          return <div key={index} className="dash-menu__separator" />;
        }
        if (item.kind === "heading") {
          return (
            <div key={index} className="dash-menu__heading">
              {item.label}
            </div>
          );
        }
        const content = (
          <>
            {item.icon && <span className="dash-menu__icon">{item.icon}</span>}
            <span className="dash-menu__label">{item.label}</span>
            {item.hint && <Kbd keys={item.hint} />}
            {item.selected && <span className="dash-menu__check">·</span>}
          </>
        );
        const className = clsx("dash-menu__item", {
          "dash-menu__item--danger": item.danger,
          "dash-menu__item--selected": item.selected,
        });
        const select = () => {
          if (item.disabled) {
            return;
          }
          onClose();
          item.onSelect();
        };
        if (item.href) {
          return (
            <a
              key={index}
              role="menuitem"
              tabIndex={-1}
              className={className}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                select();
              }}
              onAuxClick={() => onClose()}
            >
              {content}
            </a>
          );
        }
        return (
          <button
            key={index}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={className}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            onClick={select}
          >
            {content}
          </button>
        );
      })}
    </div>,
    document.body,
  );
};

/** Bookkeeping for a trigger + Menu pair. */
export const useMenu = () => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = useCallback(
    (event: React.MouseEvent<HTMLElement> | HTMLElement) => {
      const element =
        event instanceof HTMLElement
          ? event
          : (event.currentTarget as HTMLElement);
      setAnchor((current) => (current === element ? null : element));
    },
    [],
  );
  const close = useCallback(() => setAnchor(null), []);
  return { anchor, open, close, isOpen: anchor !== null };
};

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export const Modal = ({
  title,
  onClose,
  children,
  size = "small",
  footer,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  size?: "small" | "medium";
  footer?: React.ReactNode;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const autofocus = ref.current?.querySelector<HTMLElement>(
      "[data-autofocus], input, button",
    );
    autofocus?.focus();
    return () => previous?.focus?.();
  }, []);

  return createPortal(
    <div
      className="dash-portal dash-modal__backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={clsx("dash-modal", `dash-modal--${size}`)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="dash-modal__header">
          <h2 id={titleId} className="dash-modal__title">
            {title}
          </h2>
          <IconButton
            label="Close"
            className="dash-modal__close"
            onClick={onClose}
          >
            {CloseIcon}
          </IconButton>
        </div>
        <div className="dash-modal__body">{children}</div>
        {footer && <div className="dash-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

type Toast = { id: number; message: string; kind: "error" | "info" };

const ToastContext = createContext<{
  push: (message: string, kind?: Toast["kind"]) => void;
}>({ push: () => undefined });

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, kind: Toast["kind"] = "error") => {
    const id = ++counter.current;
    setToasts((current) => [...current, { id, message, kind }]);
    window.setTimeout(
      () => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      },
      kind === "error" ? 6000 : 3500,
    );
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {toasts.length > 0 &&
        createPortal(
          <div
            className="dash-portal dash-toasts"
            role="status"
            aria-live="polite"
          >
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className={clsx("dash-toast", `dash-toast--${toast.kind}`)}
              >
                {toast.message}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);

export const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) {
    return `${fallback}: ${error.message}`;
  }
  return fallback;
};
