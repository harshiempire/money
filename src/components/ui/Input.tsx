import { cn } from "@/lib/cn";

export function Input({
  label,
  hint,
  error,
  className,
  id,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
}) {
  const inputId = id ?? (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

  return (
    <div className={className}>
      {label && (
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-[var(--color-text)]"
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={cn(
          "mt-1.5 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] transition-colors focus-ring focus:border-[var(--color-accent)]",
          error && "border-[var(--color-debit)]",
        )}
        {...props}
      />
      {hint && !error && (
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">{hint}</p>
      )}
      {error && (
        <p className="mt-1 text-xs text-[var(--color-debit)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Select({
  label,
  className,
  children,
  id,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
}) {
  const selectId = id ?? (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

  return (
    <div className={className}>
      {label && (
        <label
          htmlFor={selectId}
          className="block text-sm font-medium text-[var(--color-text)]"
        >
          {label}
        </label>
      )}
      <select
        id={selectId}
        className="mt-1.5 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2.5 text-sm text-[var(--color-text)] focus-ring focus:border-[var(--color-accent)]"
        {...props}
      >
        {children}
      </select>
    </div>
  );
}
