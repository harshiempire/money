"use client";

import { useSyncExternalStore } from "react";

type ThemeChoice = "light" | "dark" | "system";

const THEME_CHANGE_EVENT = "money:theme-change";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  };
}

function getSnapshot(): ThemeChoice {
  const stored = localStorage.getItem("theme");
  return stored === "light" || stored === "dark" ? stored : "system";
}

function getServerSnapshot(): ThemeChoice {
  return "system";
}

function applyTheme(choice: ThemeChoice) {
  if (choice === "system") {
    localStorage.removeItem("theme");
    document.documentElement.removeAttribute("data-theme");
  } else {
    localStorage.setItem("theme", choice);
    document.documentElement.setAttribute("data-theme", choice);
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const cycle = () => {
    const next: ThemeChoice =
      choice === "system" ? "light" : choice === "light" ? "dark" : "system";
    applyTheme(next);
  };

  const label =
    choice === "light" ? "Light" : choice === "dark" ? "Dark" : "System";

  return (
    <button
      type="button"
      onClick={cycle}
      className="text-xs text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
      aria-label={`Theme: ${label}. Click to cycle.`}
    >
      {label}
    </button>
  );
}
