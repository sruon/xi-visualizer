export async function compress(inString) {
  const compressedStream = new Response(inString).body!.pipeThrough(
    new CompressionStream("deflate"),
  );
  return await new Response(compressedStream).arrayBuffer();
}

export async function decompress(bytes, format: CompressionFormat = "deflate") {
  const decompressedStream = new Response(bytes).body!.pipeThrough(
    new DecompressionStream(format),
  );
  return await new Response(decompressedStream).arrayBuffer();
}

export async function fetchProgress(url: string, setProgress: (progress: number) => any): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : null;

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytesRead = 0;

  setProgress(0);
  while (true) {
    const stream = await reader.read();
    if (stream.done) {
      break;
    }
    bytesRead += stream.value.length;

    chunks.push(stream.value);
    setProgress(total ? bytesRead / total : undefined);
  }

  const blob = new Blob(chunks);
  setProgress(undefined);
  return await blob.arrayBuffer();
}
