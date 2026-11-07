// Raw DEFLATE via the platform CompressionStream. No dependency: both bun and
// every browser that runs this app ship it, and `deflate-raw` is the format with
// no wrapper bytes around the stream.
//
// DEFLATE shrinks the invite payload roughly 2.6x (a 3-member vault: 832 bytes of
// base64url down to 368). It is compression, not protection: a link is readable by
// anyone holding it either way, which is the point of the link.

/** Throws if the runtime has no CompressionStream; `invite.ts` surfaces that as a share failure. */
async function transform(stream: CompressionStream | DecompressionStream, input: Uint8Array): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // A fresh ArrayBuffer copy: a Uint8Array view can be backed by a SharedArrayBuffer,
  // which `CompressionStream` does not accept.
  const chunk = new Uint8Array(input.length);
  chunk.set(input);
  // The writer must be closed before the readable end settles, but awaiting the
  // write first deadlocks on a large input: the output buffer fills while we wait.
  //
  // Both rejections are swallowed here on purpose. When the input is not a valid
  // stream the readable end errors first, which rejects the pending write and close
  // too; that secondary rejection is an unhandled promise rejection that crashes a
  // bun process after the caller already handled the real error.
  void writer.write(chunk).catch(() => {}).then(() => writer.close()).catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
  return transform(new CompressionStream('deflate-raw'), input);
}

export function inflateRaw(input: Uint8Array): Promise<Uint8Array> {
  return transform(new DecompressionStream('deflate-raw'), input);
}
