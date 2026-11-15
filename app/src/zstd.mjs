/**
 * 纯 JS 的多帧 zstd 解压：DSH 日志是"一帧 header + 每批一帧"的拼接，
 * 内置 zstdDecompressSync 只解第一帧，这里按 frame/block 结构逐帧切。
 * 不依赖系统 zstd，Windows 上也能跑。
 */
import zlib from "node:zlib";

const MAGIC = 0xfd2fb528;

function frameEnd(buf, start) {
  if (start + 4 > buf.length) return -1;
  if (buf.readUInt32LE(start) !== MAGIC) return -1;
  let p = start + 4;
  const fhd = buf.readUInt8(p++);
  const fcsFlag = (fhd >> 6) & 3;
  const singleSegment = (fhd >> 5) & 1;
  const hasChecksum = (fhd >> 2) & 1;
  const didFlag = fhd & 3;

  if (!singleSegment) p += 1; // Window_Descriptor
  p += [0, 1, 2, 4][didFlag]; // Dictionary_ID

  let fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  p += fcsSize;

  for (;;) {
    if (p + 3 > buf.length) return -1;
    const h = buf.readUIntLE(p, 3);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    if (type === 0) p += size;            // Raw
    else if (type === 1) p += 1;          // RLE
    else if (type === 2) p += size;       // Compressed
    else return -1;                        // Reserved
    if (p > buf.length) return -1;
    if (last) break;
  }
  if (hasChecksum) p += 4;
  return p;
}

/** 把所有帧解压后拼成一个 Buffer。 */
export function decompressAllFrames(buf) {
  const out = [];
  let p = 0;
  let frames = 0;
  while (p < buf.length) {
    const end = frameEnd(buf, p);
    if (end < 0) {
      // 可能遇到 skippable frame（magic 0x184D2A5?），跳过
      if (p + 8 <= buf.length && (buf.readUInt32LE(p) & 0xfffffff0) === 0x184d2a50) {
        const size = buf.readUInt32LE(p + 4);
        p += 8 + size;
        continue;
      }
      throw new Error(`无法解析 zstd 帧（offset ${p}）`);
    }
    out.push(zlib.zstdDecompressSync(buf.subarray(p, end)));
    frames++;
    p = end;
  }
  return { buffer: Buffer.concat(out), frames };
}

/** 只解出"完整的帧"，返回消费到哪个字节（用于实时 tail 一个正在写的日志）。 */
export function decompressPrefix(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const end = frameEnd(buf, p);
    if (end < 0) break;
    out.push(zlib.zstdDecompressSync(buf.subarray(p, end)));
    p = end;
  }
  return { buffer: Buffer.concat(out), consumed: p, frames: out.length };
}
