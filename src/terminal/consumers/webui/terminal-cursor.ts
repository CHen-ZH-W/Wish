import type { IDisposable, Terminal } from "@xterm/xterm";

/** Keep a blinking block cursor readable over ANSI, true-color, and inverse-video cells. */
export function observeUserTerminalCursor(terminal: Terminal, node: HTMLElement, preferredCursor: () => string): IDisposable {
  return terminal.onRender(() => {
    const cursor = node.querySelector<HTMLElement>(".xterm-cursor");
    if (cursor === null) return;
    cursor.classList.remove("xterm-cursor");
    let background: string;
    let foreground: string;
    try {
      const style = getComputedStyle(cursor);
      foreground = style.color;
      background = opaqueColor(style.backgroundColor, () => getComputedStyle(node.querySelector(".xterm-scrollable-element") as Element).backgroundColor);
    } finally {
      cursor.classList.add("xterm-cursor");
    }
    const preferred = opaqueColor(preferredCursor(), () => background);
    const backgroundLuminance = luminance(background);
    const preferredLuminance = luminance(preferred);
    const contrast = (Math.max(backgroundLuminance, preferredLuminance) + 0.05) / (Math.min(backgroundLuminance, preferredLuminance) + 0.05);
    const fill = contrast >= 3 ? preferred : backgroundLuminance > 0.179 ? "#000000" : "#ffffff";
    node.style.setProperty("--terminal-cursor", fill);
    node.style.setProperty("--terminal-cursor-accent", luminance(fill) > 0.179 ? "#000000" : "#ffffff");
    node.style.setProperty("--terminal-cursor-cell-background", background);
    node.style.setProperty("--terminal-cursor-cell-foreground", foreground);
  });
}

function luminance(color: string): number {
  const [red = 0, green = 0, blue = 0] = colorChannels(color).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function colorChannels(color: string): number[] {
  return color.startsWith("#")
    ? [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map(value => Number.parseInt(value, 16))
    : (color.match(/[\d.]+/gu) ?? []).map(Number);
}

function opaqueColor(color: string, background: () => string): string {
  const channels = colorChannels(color);
  const alpha = channels[3] ?? 1;
  if (alpha === 1) return color;
  const surface = colorChannels(background());
  const rgb = channels.slice(0, 3).map((channel, index) => Math.round(channel * alpha + (surface[index] ?? 0) * (1 - alpha)));
  return `rgb(${rgb.join(", ")})`;
}
