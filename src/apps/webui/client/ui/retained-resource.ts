/** Activity pauses Effects while preserving DOM. Release a retained resource only when its node actually leaves the document. */
export function onRetainedNodeRemoval(node: HTMLElement, dispose: () => void): () => void {
  let watching = true;
  const stop = (): void => { watching = false; observer.disconnect(); };
  const check = (): void => {
    if (!watching || node.isConnected) return;
    stop(); dispose();
  };
  const observer = new MutationObserver(check);
  observer.observe(node.ownerDocument, { childList: true, subtree: true });
  queueMicrotask(check);
  return stop;
}
