"use client";

import { useEffect, useState } from "react";

type ThemeChoice = "light" | "dark" | "system";

function applyTheme(choice: ThemeChoice) {
  if (choice === "system") {
    localStorage.removeItem("theme");
    document.documentElement.removeAttribute("data-theme");
  } else {
    localStorage.setItem("theme", choice);
    document.documentElement.setAttribute("data-theme", choice);
  }
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") {
      setChoice(stored);
    }
  }, []);

  const cycle = () => {
    const next: ThemeChoice =
      choice === "system" ? "light" : choice === "light" ? "dark" : "system";
    setChoice(next);
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
