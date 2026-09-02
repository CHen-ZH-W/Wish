export interface SseMessage {
  readonly event?: string;
  readonly data: string;
}

export async function* decodeSse(response: Response): AsyncIterable<SseMessage> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("SSE response body is unavailable");
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const dispatch = (): SseMessage | undefined => {
    if (data.length === 0) {
      event = undefined;
      return undefined;
    }
    const message = Object.freeze({
      ...(event === undefined ? {} : { event }),
      data: data.join("\n"),
    });
    event = undefined;
    data = [];
    return message;
  };
  const consumeLine = (line: string): SseMessage | undefined => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) return dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
    return undefined;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const message = consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message !== undefined) yield message;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const message = consumeLine(buffer);
      if (message !== undefined) yield message;
    }
    const final = dispatch();
    if (final !== undefined) yield final;
  } finally {
    reader.releaseLock();
  }
}
