import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalRenderFrame } from "./model.js";
import { observeUserTerminalCursor } from "./terminal-cursor.js";
import { UserTerminalTheme } from "./terminal-theme.js";

export interface TerminalScreenProps {
  readonly terminalId: string;
  readonly render: TerminalRenderFrame | undefined;
  readonly active: boolean;
  readonly writable: boolean;
  readonly label: string;
  readonly onData: (data: string) => void;
  readonly onResize: (columns: number, rows: number) => void;
  readonly onRendered: (revision: number) => void;
}

/** A stable xterm mount; snapshots update its screen without replacing the DOM. */
export function TerminalScreen({ terminalId, render, active, writable, label, onData, onResize, onRendered }: TerminalScreenProps): ReactNode {
  const element = useRef<HTMLDivElement>(null);
  const emulator = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const colors = useRef<UserTerminalTheme | null>(null);
  const latest = useRef({ onData, onResize, onRendered, active, writable });
  const rendered = useRef(0);
  const requestedSize = useRef<{ readonly columns: number; readonly rows: number } | undefined>(undefined);
  latest.current = { onData, onResize, onRendered, active, writable };

  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: 'ui-monospace, "Cascadia Code", "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      scrollback: 500,
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(node);
    const palette = new UserTerminalTheme(terminal);
    colors.current = palette;
    updateTerminalTheme(palette, node);
    const cursor = observeUserTerminalCursor(terminal, node, () => palette.cursor);
    terminal.textarea?.setAttribute("aria-label", label);
    const input = terminal.onData(data => latest.current.onData(data));
    const resize = (): void => {
      if (!latest.current.writable || !node.clientWidth || !node.clientHeight) return;
      const dimensions = addon.proposeDimensions();
      if (!dimensions || dimensions.cols < 20 || dimensions.rows < 5) return;
      terminal.resize(dimensions.cols, dimensions.rows);
      if (requestedSize.current?.columns !== dimensions.cols || requestedSize.current.rows !== dimensions.rows) {
        requestedSize.current = { columns: dimensions.cols, rows: dimensions.rows };
        latest.current.onResize(dimensions.cols, dimensions.rows);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    emulator.current = terminal; fit.current = addon; rendered.current = 0; requestedSize.current = undefined;
    resize();
    queueMicrotask(() => { if (latest.current.writable) terminal.focus(); });
    return () => {
      observer.disconnect(); input.dispose(); cursor.dispose(); palette.dispose(); terminal.dispose();
      emulator.current = null; fit.current = null; colors.current = null; rendered.current = 0; requestedSize.current = undefined;
    };
  }, [terminalId]);

  useLayoutEffect(() => {
    const terminal = emulator.current;
    if (!terminal || render === undefined || render.revision <= rendered.current) return;
    rendered.current = render.revision;
    if (render.frame.type === "snapshot") {
      terminal.reset();
      colors.current?.reapply();
      terminal.options.cursorBlink = latest.current.active && latest.current.writable;
      terminal.options.cursorStyle = "block";
      terminal.resize(render.frame.terminal.columns, render.frame.terminal.rows);
      terminal.write(render.frame.screen, () => {
        latest.current.onRendered(render.revision);
        if (latest.current.writable) terminal.focus();
      });
      return;
    }
    terminal.write(render.frame.data, () => {
      latest.current.onRendered(render.revision);
      if (latest.current.writable) terminal.focus();
    });
  }, [render]);

  useEffect(() => {
    const terminal = emulator.current; if (!terminal) return;
    terminal.options.disableStdin = !writable;
    terminal.options.cursorBlink = active && writable;
    const node = element.current, addon = fit.current;
    if (writable && node?.clientWidth && node.clientHeight && addon) {
      const dimensions = addon.proposeDimensions();
      if (dimensions && dimensions.cols >= 20 && dimensions.rows >= 5) {
        terminal.resize(dimensions.cols, dimensions.rows);
        if (requestedSize.current?.columns !== dimensions.cols || requestedSize.current.rows !== dimensions.rows) {
          requestedSize.current = { columns: dimensions.cols, rows: dimensions.rows };
          latest.current.onResize(dimensions.cols, dimensions.rows);
        }
      }
      terminal.focus();
    }
  }, [active, writable]);

  useEffect(() => {
    const terminal = emulator.current; if (!terminal) return;
    terminal.textarea?.setAttribute("aria-label", label);
  }, [label]);

  useEffect(() => {
    const root = document.documentElement;
    const update = (): void => { if (colors.current && element.current) updateTerminalTheme(colors.current, element.current); };
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return <div className="user-terminal-screen" ref={element} data-terminal-id={terminalId} />;
}

function updateTerminalTheme(theme: UserTerminalTheme, node: HTMLElement): void {
  const style = getComputedStyle(node);
  theme.update(style.backgroundColor || "#ffffff", style.color || "#202c3e");
}
