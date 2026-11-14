import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

function compress(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      compress(path);
      continue;
    }
    if (!/\.(?:js|css|html|svg)$/.test(path)) continue;
    const source = readFileSync(path);
    if (source.byteLength < 512) continue;
    const variants = {
      br: brotliCompressSync(source, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 9,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        },
      }),
      gz: gzipSync(source, { level: 9 }),
    };
    for (const [extension, content] of Object.entries(variants))
      if (content.byteLength < source.byteLength)
        writeFileSync(`${path}.${extension}`, content);
  }
}
compress("dist");
