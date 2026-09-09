import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

const concatBuffers = (...chunks) => {
  const out = Buffer.alloc(4 + chunks.reduce((n, c) => n + 4 + c.length, 0));
  out.writeUInt32BE(1);
  let offset = 4;
  for (const chunk of chunks) {
    out.writeUInt32BE(chunk.length, offset);
    Buffer.from(chunk).copy(out, offset + 4);
    offset += 4 + chunk.length;
  }
  return out;
};
const key = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
const cryptoKey = await globalThis.crypto.subtle.importKey(
  "raw", key, "AES-GCM", false, ["encrypt"],
);
const encryptData = async (data, iv) => Buffer.from(
  await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, data),
);
const info = Buffer.from(JSON.stringify({
  version: 2, compression: "pako@1", encryption: "AES-GCM",
}));
const vectors = [];
for (const [name, data, metadata] of [
  ["room", '[{"id":"rectangle","version":7,"text":"Hello 世界"}]', null],
  ["file", "data:image/png;base64,iVBORw0KGgo=", {id: "image1", mimeType: "image/png", created: 1700000000000, lastRetrieved: 1700000000001}],
  ["snapshot", '{"type":"excalidraw","elements":[]}', null],
  ["empty", "", null],
]) {
  // Fixed IVs make committed interoperability fixtures reproducible, never production keys.
  const iv = Buffer.from(Array.from({length:12}, (_,i) => i + vectors.length * 12));
  const plaintext = Buffer.from(data);
  const ciphertext = await encryptData(plaintext, iv);
  const compressed = deflateSync(concatBuffers(Buffer.from(JSON.stringify(metadata)), plaintext));
  const envelope = concatBuffers(info, iv, await encryptData(compressed, iv));
  vectors.push({name, key:key.toString("base64url"), iv:iv.toString("base64"),
    plaintext:plaintext.toString("base64"), ciphertext:ciphertext.toString("base64"),
    metadata, envelope:envelope.toString("base64")});
}
const dir = new URL("../server/internal/crypto/testdata/", import.meta.url);
await mkdir(dir, {recursive:true});
await writeFile(new URL("vectors.json", dir), JSON.stringify(vectors, null, 2) + "\n");
