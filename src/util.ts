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

export function binarySearchLower<T, U>(arr: T[], value: U, valueExtract: (t: T) => U) {
  let lo = 0;
  let hi = arr.length - 1;
  let mid = 0;
  let extracted;
  while (lo < hi) {
    mid = Math.floor((hi - lo) / 2) + lo;
    extracted = valueExtract(arr[mid]);
    if (extracted < value) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return lo;
}

export function deepMerge(...objs: any[]): any {
  if (objs.length == 1) {
    return objs[0];
  }

  const res = {};
  for (const obj of objs) {
    if (typeof obj != "object") {
      continue;
    }

    for (const key in obj) {
      const val = obj[key]
      if (typeof val == "object") {
        res[key] = deepMerge(res[key], val)
      } else {
        res[key] = val
      }
    }
  }

  return res;
}