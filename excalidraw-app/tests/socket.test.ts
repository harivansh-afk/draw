import { decodeFrame, encodeFrame, getWebSocketUrl } from "../collab/socket";

describe("socket framing", () => {
  it("round-trips JSON and binary arguments", () => {
    const ciphertext = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const iv = new Uint8Array([9, 8, 7]);
    const frame = encodeFrame("server-broadcast", ["room-1", ciphertext, iv]);

    const bytes = new Uint8Array(frame);
    expect(bytes[0]).toBe(0x01);
    const headerLength = new DataView(frame).getUint32(1);
    const header = JSON.parse(
      new TextDecoder().decode(bytes.subarray(5, 5 + headerLength)),
    );
    expect(header).toEqual({
      e: "server-broadcast",
      a: ["room-1", { $b: 0 }, { $b: 1 }],
      b: [5, 3],
    });

    const decoded = decodeFrame(frame);
    expect(decoded.event).toBe("server-broadcast");
    expect(decoded.args[0]).toBe("room-1");
    expect(new Uint8Array(decoded.args[1] as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    expect(new Uint8Array(decoded.args[2] as ArrayBuffer)).toEqual(
      new Uint8Array([9, 8, 7]),
    );
  });

  it("omits the attachment list when there are no binaries", () => {
    const frame = encodeFrame("join-room", ["abc"]);
    const headerLength = new DataView(frame).getUint32(1);
    const header = JSON.parse(
      new TextDecoder().decode(new Uint8Array(frame, 5, headerLength)),
    );
    expect(header).toEqual({ e: "join-room", a: ["abc"] });
    expect(frame.byteLength).toBe(5 + headerLength);
  });

  it("rejects frames with a wrong version or truncated payload", () => {
    const frame = new Uint8Array(encodeFrame("x", [new Uint8Array(4)]));
    frame[0] = 0x02;
    expect(() => decodeFrame(frame.buffer)).toThrow(/invalid frame/);

    const truncated = new Uint8Array(encodeFrame("x", [new Uint8Array(4)]));
    expect(() =>
      decodeFrame(truncated.slice(0, truncated.byteLength - 2).buffer),
    ).toThrow(/truncated attachment/);
  });

  it("derives the websocket url from the page origin by default", () => {
    expect(getWebSocketUrl("")).toBe(`ws://${window.location.host}/api/ws`);
    expect(getWebSocketUrl("https://draw.example.com")).toBe(
      "wss://draw.example.com/api/ws",
    );
    expect(getWebSocketUrl("http://localhost:34729/custom")).toBe(
      "ws://localhost:34729/custom",
    );
  });
});
