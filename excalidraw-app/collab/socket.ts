/**
 * WebSocket transport for the draw server (`/api/ws`), exposing the subset of
 * the socket.io-client surface Portal and Collab use. Framing is defined in
 * SPEC.md ("WebSocket").
 */

const FRAME_VERSION = 0x01;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;

type Listener = (...args: any[]) => void;

type BinaryArg = ArrayBuffer | Uint8Array;

type Header = {
  e: string;
  a: unknown[];
  b?: number[];
};

const isBinaryArg = (value: unknown): value is BinaryArg =>
  value instanceof ArrayBuffer || value instanceof Uint8Array;

const toBytes = (value: BinaryArg): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

export const encodeFrame = (event: string, args: unknown[]): ArrayBuffer => {
  const attachments: Uint8Array[] = [];
  const headerArgs = args.map((arg) => {
    if (isBinaryArg(arg)) {
      attachments.push(toBytes(arg));
      return { $b: attachments.length - 1 };
    }
    return arg;
  });
  const header: Header = { e: event, a: headerArgs };
  if (attachments.length) {
    header.b = attachments.map((bytes) => bytes.byteLength);
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const total =
    5 +
    headerBytes.byteLength +
    attachments.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  frame[0] = FRAME_VERSION;
  view.setUint32(1, headerBytes.byteLength);
  frame.set(headerBytes, 5);
  let cursor = 5 + headerBytes.byteLength;
  for (const bytes of attachments) {
    frame.set(bytes, cursor);
    cursor += bytes.byteLength;
  }
  return frame.buffer;
};

export const decodeFrame = (
  data: ArrayBuffer,
): { event: string; args: unknown[] } => {
  const frame = new Uint8Array(data);
  if (frame.byteLength < 5 || frame[0] !== FRAME_VERSION) {
    throw new Error("socket: invalid frame");
  }
  const headerLength = new DataView(data).getUint32(1);
  if (5 + headerLength > frame.byteLength) {
    throw new Error("socket: truncated header");
  }
  const header: Header = JSON.parse(
    new TextDecoder().decode(frame.subarray(5, 5 + headerLength)),
  );
  const lengths = header.b || [];
  const attachments: ArrayBuffer[] = [];
  let cursor = 5 + headerLength;
  for (const length of lengths) {
    if (cursor + length > frame.byteLength) {
      throw new Error("socket: truncated attachment");
    }
    attachments.push(frame.slice(cursor, cursor + length).buffer);
    cursor += length;
  }
  const args = (header.a || []).map((arg) => {
    if (
      arg &&
      typeof arg === "object" &&
      "$b" in arg &&
      typeof (arg as { $b: unknown }).$b === "number"
    ) {
      const attachment = attachments[(arg as { $b: number }).$b];
      if (!attachment) {
        throw new Error("socket: missing attachment");
      }
      return attachment;
    }
    return arg;
  });
  return { event: header.e, args };
};

export const getWebSocketUrl = (base: string | undefined): string => {
  if (base) {
    const url = new URL(base, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/api/ws";
    }
    return url.toString();
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/ws`;
};

export class Socket {
  id: string | undefined = undefined;
  connected = false;

  private url: string;
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private onceListeners = new Map<string, Set<Listener>>();
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private everConnected = false;

  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  once(event: string, listener: Listener) {
    if (!this.onceListeners.has(event)) {
      this.onceListeners.set(event, new Set());
    }
    this.onceListeners.get(event)!.add(listener);
    return this;
  }

  off(event: string, listener?: Listener) {
    if (!listener) {
      this.listeners.delete(event);
      this.onceListeners.delete(event);
      return this;
    }
    this.listeners.get(event)?.delete(listener);
    this.onceListeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return this;
    }
    this.ws.send(encodeFrame(event, args));
    return this;
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
    this.connected = false;
    this.listeners.clear();
    this.onceListeners.clear();
  }

  private dispatch(event: string, args: unknown[]) {
    const once = this.onceListeners.get(event);
    if (once) {
      this.onceListeners.delete(event);
      for (const listener of once) {
        listener(...args);
      }
    }
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of [...listeners]) {
        listener(...args);
      }
    }
  }

  private connect() {
    if (this.closed) {
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (error: any) {
      this.onFailure(error);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.everConnected = true;
      this.reconnectAttempt = 0;
      this.connected = true;
      this.dispatch("connect", []);
    };
    ws.onmessage = (message: MessageEvent) => {
      if (!(message.data instanceof ArrayBuffer)) {
        return;
      }
      let decoded: { event: string; args: unknown[] };
      try {
        decoded = decodeFrame(message.data);
      } catch (error: any) {
        console.error(error);
        return;
      }
      if (decoded.event === "hello") {
        this.id = String(decoded.args[0]);
        return;
      }
      if (decoded.event === "client-broadcast") {
        // upstream expects (ArrayBuffer ciphertext, Uint8Array iv)
        const [ciphertext, iv] = decoded.args as [ArrayBuffer, ArrayBuffer];
        this.dispatch("client-broadcast", [
          ciphertext,
          iv instanceof ArrayBuffer ? new Uint8Array(iv) : iv,
        ]);
        return;
      }
      this.dispatch(decoded.event, decoded.args);
    };
    ws.onerror = () => {
      // the close event that follows carries the reconnect logic
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) {
        return;
      }
      this.ws = null;
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) {
        this.dispatch("disconnect", [event.reason || "transport close"]);
      } else {
        this.onFailure(new Error(event.reason || "websocket error"));
      }
      if (event.code === 4403) {
        this.closed = true;
        return;
      }
      this.scheduleReconnect();
    };
  }

  private onFailure(error: Error) {
    if (!this.everConnected && this.reconnectAttempt === 0) {
      this.dispatch("connect_error", [error]);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer !== null) {
      return;
    }
    const base = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * 2 ** this.reconnectAttempt,
    );
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectAttempt++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export const io = (url?: string) => new Socket(getWebSocketUrl(url));

export default io;
