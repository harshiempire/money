"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  MAX_MONTH_YEAR,
  MIN_MONTH_YEAR,
  initialPickerYear,
  monthJumpOptions,
  parseMonthKey,
} from "@/lib/spend/month-jump";

export function MonthJump({
  label,
  selectedMonthKey,
  anchorMonthKey,
  todayMonthKey,
  basePath = "/spend",
  variant,
}: {
  label: string;
  selectedMonthKey?: string;
  anchorMonthKey?: string;
  todayMonthKey: string;
  basePath?: string;
  variant: "label" | "chip";
}) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() =>
    initialPickerYear(selectedMonthKey, anchorMonthKey),
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const openPicker = () => {
    setYear(initialPickerYear(selectedMonthKey, anchorMonthKey));
    setOpen(true);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={
          variant === "label"
            ? "inline-flex items-start justify-center gap-1 rounded px-1 py-0.5 text-center font-medium leading-tight"
            : "rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          variant === "label" ? `Choose month, ${label}` : "Jump to month"
        }
        onClick={openPicker}
      >
        {variant === "label" ? (
          <>
            <span>{label}</span>
            <Chevron />
          </>
        ) : (
          "Jump to month"
        )}
      </button>
      {open ? (
        <MonthJumpDialog
          titleId={titleId}
          year={year}
          selectedMonthKey={selectedMonthKey}
          todayMonthKey={todayMonthKey}
          basePath={basePath}
          onYear={setYear}
          onClose={() => {
            setOpen(false);
            buttonRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500"
    >
      <path
        d="M4 6l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MonthJumpDialog({
  titleId,
  year,
  selectedMonthKey,
  todayMonthKey,
  basePath,
  onYear,
  onClose,
}: {
  titleId: string;
  year: number;
  selectedMonthKey?: string;
  todayMonthKey: string;
  basePath: string;
  onYear: (year: number) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const months = monthJumpOptions(year, basePath);
  const today = parseMonthKey(todayMonthKey);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (!dialog.open) return;
      // Unmount (including Strict Mode remount) must dismiss the top layer
      // without telling the parent to close, or the picker would shut immediately.
      dialog.addEventListener(
        "close",
        (event) => event.stopImmediatePropagation(),
        { capture: true, once: true },
      );
      dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="m-auto w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-neutral-200 bg-white p-4 text-neutral-900 shadow-lg backdrop:bg-black/60 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-sm font-medium">
          Jump to month
        </h2>
        <button
          type="button"
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
          onClick={() => dialogRef.current?.close()}
        >
          Close
        </button>
      </div>
      <div className="mt-3 flex items-center justify-center gap-4">
        <button
          type="button"
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700"
          aria-label="Previous year"
          disabled={year <= MIN_MONTH_YEAR}
          onClick={() => {
            if (year > MIN_MONTH_YEAR) onYear(year - 1);
          }}
        >
          ←
        </button>
        <div className="min-w-16 text-center font-medium">{year}</div>
        <button
          type="button"
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700"
          aria-label="Next year"
          disabled={year >= MAX_MONTH_YEAR}
          onClick={() => {
            if (year < MAX_MONTH_YEAR) onYear(year + 1);
          }}
        >
          →
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {months.map((month) => {
          const selected = month.monthKey === selectedMonthKey;
          const isToday =
            today?.year === year && today.month === month.month;
          return (
            <a
              key={month.monthKey}
              href={month.href}
              aria-label={month.longLabel}
              aria-current={selected ? "date" : undefined}
              autoFocus={selected}
              className={`flex h-11 items-center justify-center rounded border text-sm ${
                selected
                  ? "border-neutral-900 bg-neutral-900 font-medium text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                  : "border-neutral-300 text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
              }`}
            >
              <span className="flex flex-col items-center leading-none">
                {month.shortLabel}
                {isToday ? (
                  <span
                    className={`mt-1 h-1 w-1 rounded-full ${
                      selected
                        ? "bg-white dark:bg-neutral-900"
                        : "bg-neutral-900 dark:bg-neutral-100"
                    }`}
                  />
                ) : null}
              </span>
            </a>
          );
        })}
      </div>
    </dialog>
  );
}
