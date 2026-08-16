export type ThemePreference = "dark" | "light" | "system";

const THEME_KEY = "ariaRelayTheme";

export async function initializeTheme(): Promise<ThemePreference> {
  const stored = await chrome.storage.local.get(THEME_KEY);
  const preference = isThemePreference(stored[THEME_KEY]) ? stored[THEME_KEY] : "system";
  applyTheme(preference);
  return preference;
}

export async function toggleTheme(): Promise<ThemePreference> {
  const isDark = getResolvedTheme() === "dark";
  const next: ThemePreference = isDark ? "light" : "dark";
  await chrome.storage.local.set({ [THEME_KEY]: next });
  applyTheme(next);
  return next;
}

export async function setTheme(preference: ThemePreference): Promise<void> {
  await chrome.storage.local.set({ [THEME_KEY]: preference });
  applyTheme(preference);
}

export function applyTheme(preference: ThemePreference): void {
  if (preference === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = preference;
  }
  document.documentElement.style.colorScheme = preference === "system" ? "light dark" : preference;
}

export function getResolvedTheme(): "dark" | "light" {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") {
    return explicit;
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}
