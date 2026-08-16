export function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

export function setHidden(element: HTMLElement, hidden: boolean): void {
  element.hidden = hidden;
}

export function setButtonPending(
  button: HTMLButtonElement,
  pending: boolean,
  pendingLabel = "处理中…"
): void {
  if (pending) {
    button.dataset.originalLabel = button.textContent ?? "";
    button.textContent = pendingLabel;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    return;
  }

  if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
  }
  button.disabled = false;
  button.removeAttribute("aria-busy");
  delete button.dataset.originalLabel;
}

export function createIcon(path: string, className = "icon"): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const pathElement = document.createElementNS(namespace, "path");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add(className);
  pathElement.setAttribute("d", path);
  svg.append(pathElement);
  return svg;
}

export const ICON_PATHS = {
  add: "M12 5v14M5 12h14",
  check: "m5 12 4 4L19 6",
  chevron: "m9 18 6-6-6-6",
  close: "M6 6l12 12M18 6 6 18",
  copy: "M9 9h10v10H9zM5 15H4V5h10v1",
  download: "M12 3v12m0 0 5-5m-5 5-5-5M5 21h14",
  file: "M6 3h8l4 4v14H6zM14 3v5h5",
  folder: "M3 7h7l2 2h9v10H3z",
  magnet: "M6 4v8a6 6 0 0 0 12 0V4M6 8h4M14 8h4",
  moon: "M20 15.2A8 8 0 0 1 8.8 4 8 8 0 1 0 20 15.2Z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  pause: "M9 5v14M15 5v14",
  play: "m8 5 11 7-11 7Z",
  refresh: "M20 7v5h-5M4 17v-5h5M6.1 8A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 11.9-2",
  search: "m21 21-4.4-4.4M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm8 3 2-1-2-3-2 .2-1.2-1.4.5-2-3-1-1.2 1.6-1.8.2-2.2-3H9l-.8 2.2-1.8-.2L5 8.2 3 8l-1 3 2 1v2l-2 1 1 3 2-.2 1.4 1.4-.2 1.8 3 1 .8-2h2l1 2 3-1-.2-1.8 1.4-1.4 2 .2 1-3-2-1Z",
  sun: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  trash: "M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6",
  upload: "M12 21V9m0 0L7 14m5-5 5 5M5 3h14",
  warning: "M12 3 2.5 20h19ZM12 9v4M12 17h.01"
} as const;
