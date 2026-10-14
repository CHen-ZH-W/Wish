import type { IDisposable, ITheme, Terminal } from "@xterm/xterm";

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
const SPECIAL_KEYS = ["foreground", "background", "cursor"] as const;

/** Preserve program-supplied OSC colors while the surrounding Wish theme changes. */
export class UserTerminalTheme implements IDisposable {
  private defaults: ITheme = {};
  private readonly indexed = new Map<number, string>();
  private readonly special = new Map<(typeof SPECIAL_KEYS)[number], string>();
  private readonly subscriptions: IDisposable[];

  constructor(private readonly terminal: Terminal) {
    const observe = (code: number, change: (data: string) => void): IDisposable =>
      terminal.parser.registerOscHandler(code, data => { change(data); return false; });
    this.subscriptions = [
      observe(4, data => {
        const parts = data.split(";");
        for (let index = 0; index + 1 < parts.length; index += 2) {
          const colorIndexValue = colorIndex(parts[index] ?? "");
          const color = oscColor(parts[index + 1] ?? "");
          if (colorIndexValue !== undefined && color !== undefined) this.indexed.set(colorIndexValue, color);
        }
      }),
      observe(104, data => {
        if (data === "") this.indexed.clear();
        else for (const part of data.split(";")) {
          const index = colorIndex(part);
          if (index !== undefined) this.indexed.delete(index);
        }
        this.apply();
      }),
      ...SPECIAL_KEYS.flatMap((key, offset) => [
        observe(10 + offset, data => {
          for (const [index, part] of data.split(";").entries()) {
            const target = SPECIAL_KEYS[offset + index];
            const color = oscColor(part);
            if (target !== undefined && color !== undefined) this.special.set(target, color);
          }
        }),
        observe(110 + offset, () => { this.special.delete(key); this.apply(); }),
      ]),
    ];
  }

  update(background: string, foreground: string): void {
    if (this.defaults.background === background && this.defaults.foreground === foreground) return;
    this.defaults = {
      background,
      foreground,
      cursor: foreground,
      cursorAccent: background,
      selectionBackground: foreground,
      selectionForeground: background,
      selectionInactiveBackground: foreground,
    };
    this.apply();
  }

  /** xterm.reset() restores option defaults; reapply captured OSC overrides afterwards. */
  reapply(): void { this.apply(); }

  get cursor(): string { return this.special.get("cursor") ?? this.defaults.cursor ?? this.defaults.foreground ?? "#ffffff"; }

  dispose(): void { for (const subscription of this.subscriptions) subscription.dispose(); }

  private apply(): void {
    const theme: ITheme = { ...this.defaults, ...Object.fromEntries(this.special) };
    for (const [index, color] of this.indexed) {
      if (index < ANSI_KEYS.length) theme[ANSI_KEYS[index] as (typeof ANSI_KEYS)[number]] = color;
      else (theme.extendedAnsi ??= [])[index - ANSI_KEYS.length] = color;
    }
    this.terminal.options.theme = theme;
  }
}

function colorIndex(value: string): number | undefined {
  return /^\d+$/u.test(value) && Number(value) < 256 ? Number(value) : undefined;
}

function oscColor(value: string): string | undefined {
  const rgb = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/iu.exec(value);
  let channels: string[];
  if (rgb !== null) {
    channels = rgb.slice(1);
    if (!channels.every(channel => channel.length === channels[0]?.length)) return undefined;
  } else {
    if (!/^#(?:[\da-f]{3}){1,4}$/iu.test(value)) return undefined;
    const width = (value.length - 1) / 3;
    channels = [value.slice(1, width + 1), value.slice(width + 1, 2 * width + 1), value.slice(2 * width + 1)];
  }
  return `#${channels.map(channel => {
    const value = rgb === null
      ? Number.parseInt(channel.padEnd(2, "0").slice(0, 2), 16)
      : Math.round(Number.parseInt(channel, 16) * 255 / (16 ** channel.length - 1));
    return value.toString(16).padStart(2, "0");
  }).join("")}`;
}
