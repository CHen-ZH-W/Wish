import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export const CENTER_MIN_WIDTH = 400;
export const LEFT_SIDEBAR_DEFAULT_WIDTH = 280;
export const LEFT_SIDEBAR_MIN_WIDTH = 264;
export const LEFT_SIDEBAR_MAX_WIDTH = 420;
export const RIGHT_SIDEBAR_MIN_WIDTH = 300;
export const RIGHT_SIDEBAR_DEFAULT_RATIO = 0.45;
export const RIGHT_SIDEBAR_MAX_RATIO = 0.7;

type SidebarSide = "left" | "right";

export function defaultRightSidebarWidth(frameWidth: number): number {
  return clamp(frameWidth * RIGHT_SIDEBAR_DEFAULT_RATIO, RIGHT_SIDEBAR_MIN_WIDTH, rightSidebarMaxWidth(frameWidth));
}

export function rightSidebarMaxWidth(frameWidth: number): number {
  const available = frameWidth - CENTER_MIN_WIDTH;
  if (available < RIGHT_SIDEBAR_MIN_WIDTH) return 0;
  return clamp(Math.min(available, frameWidth * RIGHT_SIDEBAR_MAX_RATIO), RIGHT_SIDEBAR_MIN_WIDTH, Number.MAX_SAFE_INTEGER);
}

export function resizeSidebarWidth(startWidth: number, movementX: number, side: SidebarSide, min: number, max: number): number {
  return clamp(startWidth + (side === "left" ? movementX : -movementX), min, max);
}

export function SidebarResizeHandle({ side, width, min, max, label, controls, onChange }: {
  side: SidebarSide;
  width: number;
  min: number;
  max: number;
  label: string;
  controls: string;
  onChange(width: number): void;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const latestX = useRef(0);
  const frame = useRef<number | null>(null);
  const stopDragging = useCallback(() => {
    drag.current = null;
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    handle.current?.removeAttribute("data-resizing");
    if (typeof document !== "undefined") document.documentElement.classList.remove("sidebar-resizing");
  }, []);
  useEffect(() => stopDragging, [stopDragging]);
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    latestX.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.setAttribute("data-resizing", "true");
    document.documentElement.classList.add("sidebar-resizing");
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    latestX.current = event.clientX;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      const current = drag.current;
      if (current) onChange(resizeSidebarWidth(current.startWidth, latestX.current - current.startX, side, min, max));
    });
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const active = drag.current;
    onChange(resizeSidebarWidth(active.startWidth, event.clientX - active.startX, side, min, max));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    stopDragging();
  }
  function pointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) stopDragging();
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 8;
    let next: number | undefined;
    if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "ArrowLeft") next = resizeSidebarWidth(width, -step, side, min, max);
    else if (event.key === "ArrowRight") next = resizeSidebarWidth(width, step, side, min, max);
    if (next === undefined) return;
    event.preventDefault();
    onChange(next);
  }
  return <div ref={handle} className={`sidebar-resize-handle ${side}-sidebar-resize-handle`} role="separator" aria-orientation="vertical" aria-label={label} aria-controls={controls} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} px`} tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={stopDragging} onKeyDown={keyDown} />;
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}
