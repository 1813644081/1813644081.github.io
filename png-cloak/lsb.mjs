// ============================================================================
// png-cloak LSB 引擎 —— 把文件隐写进 PNG 像素的低位(参考 WarFactory LsbTank 思路)
//
// 原理:每个像素 RGB 三通道各拿出低 b 位(b=1..7)来存数据(alpha 不动),
//       数据按"高位在前(MSB-first)"逐位写入,载体肉眼看不出变化。
//       有损压缩(JPEG)会破坏低位,所以必须用 PNG 这类无损格式保存。
//
// 容器格式(全部大端序/高位在前):
//   magic(4B)="pcl1" + version(1B) + bits(1B) + nameLen(1B)
//   + 原文件名(nameLen 字节) + payloadLen(4B, 大端) + payload...
//
// 额外设计:重新编码时保留原 PNG 的 tEXt/zTXt/iTXt 文本块(例如角色卡 JSON),
//           所以对角色卡做 LSB 隐写不会弄丢卡片数据(像素层改动 + 文本块保留)。
// ============================================================================

import zlib from 'node:zlib';
import { parsePng, buildPng } from './core.mjs';

export const MAGIC = 'pcl1';
export const VERSION = 1;
const TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt']);

// ---------------------------------------------------------------------------
// PNG 像素解码(仅需要 zlib,Node 内置)
// ---------------------------------------------------------------------------

/**
 * 把任意常见 PNG(8/16 位,灰/调色板/RGB/RGBA,非隔行)解成 8 位 RGBA。
 * @returns {{width:number, height:number, rgba:Uint8Array}}
 */
export function decodePngToRgba(bytes) {
    const chunks = parsePng(bytes);
    const ihdr = chunks.find((c) => c.name === 'IHDR');
    const idats = chunks.filter((c) => c.name === 'IDAT');
    if (!ihdr || idats.length === 0) throw new Error('PNG 缺少 IHDR/IDAT,无法解码像素');

    const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
    const width = view.getUint32(0);
    const height = view.getUint32(4);
    const bitDepth = ihdr.data[8];
    const colorType = ihdr.data[9];
    const compression = ihdr.data[10];
    const filterMethod = ihdr.data[11];
    const interlace = ihdr.data[12];
    if (compression !== 0 || filterMethod !== 0) throw new Error('PNG 使用了未知的压缩/滤波方式');
    if (interlace !== 0) throw new Error('暂不支持隔行扫描(Adam7)PNG');

    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (channels === undefined) throw new Error(`不支持的 PNG 颜色类型: ${colorType}`);
    if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`不支持的位深: ${bitDepth}(仅支持 8/16)`);
    const bytesPerSample = bitDepth === 16 ? 2 : 1;
    const stride = width * channels * bytesPerSample;

    const raw = zlib.inflateSync(Buffer.concat(idats.map((c) => Buffer.from(c.data))));
    if (raw.length < height * (stride + 1)) throw new Error('PNG 像素数据不完整');

    // 逐行逆滤波,得到原始采样字节 recon(每个字节位置 = y*(stride+1)+1+x)
    const recon = new Uint8Array(height * (stride + 1));
    const bpp = channels * bytesPerSample;
    const paeth = (a, b, c) => {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        if (pa <= pb && pa <= pc) return a;
        if (pb <= pc) return b;
        return c;
    };
    for (let y = 0; y < height; y++) {
        const rowOff = y * (stride + 1);
        const filterType = raw[rowOff];
        const prevOff = rowOff - (stride + 1);
        for (let x = 0; x < stride; x++) {
            const ci = rowOff + 1 + x;
            const cur = raw[ci];
            const left = x >= bpp ? recon[ci - bpp] : 0;
            const up = y > 0 ? recon[prevOff + 1 + x] : 0;
            const upLeft = (x >= bpp && y > 0) ? recon[prevOff + 1 + x - bpp] : 0;
            let val;
            switch (filterType) {
                case 0: val = cur; break;
                case 1: val = cur + left; break;
                case 2: val = cur + up; break;
                case 3: val = cur + ((left + up) >> 1); break;
                case 4: val = cur + paeth(left, up, upLeft); break;
                default: throw new Error(`未知 PNG 滤波类型: ${filterType}`);
            }
            recon[ci] = val & 0xff;
        }
    }

    // 采样 -> RGBA8(16 位取高字节;调色板走 PLTE/tRNS)
    const plte = chunks.find((c) => c.name === 'PLTE')?.data;
    const trns = chunks.find((c) => c.name === 'tRNS')?.data;
    const sampleAt = (y, x, ch) => recon[y * (stride + 1) + 1 + x * channels * bytesPerSample + ch * bytesPerSample];

    const rgba = new Uint8Array(width * height * 4);
    let p = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r, g, b, a = 255;
            switch (colorType) {
                case 0: r = g = b = sampleAt(y, x, 0); break;                 // 灰度
                case 2: r = sampleAt(y, x, 0); g = sampleAt(y, x, 1); b = sampleAt(y, x, 2); break;
                case 4: r = g = b = sampleAt(y, x, 0); a = sampleAt(y, x, 1); break;
                case 6: r = sampleAt(y, x, 0); g = sampleAt(y, x, 1); b = sampleAt(y, x, 2); a = sampleAt(y, x, 3); break;
                case 3: {                                                                      // 调色板
                    if (!plte) throw new Error('调色板 PNG 缺少 PLTE');
                    const idx = sampleAt(y, x, 0);
                    if (idx * 3 + 2 >= plte.length) throw new Error('调色板索引越界');
                    r = plte[idx * 3]; g = plte[idx * 3 + 1]; b = plte[idx * 3 + 2];
                    if (trns && idx < trns.length) a = trns[idx];
                    break;
                }
            }
            rgba[p++] = r; rgba[p++] = g; rgba[p++] = b; rgba[p++] = a;
        }
    }
    return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// RGBA8 -> 新 PNG(RGBA/8位/无隔行,行滤波全 0;保留原 tEXt/zTXt/iTXt 文本块)
// ---------------------------------------------------------------------------

export function encodeRgbaToPng(width, height, rgba, originalChunks = []) {
    const stride = width * 4;
    const raw = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter: None
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    const deflated = zlib.deflateSync(raw, { level: 9 });

    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, width);
    v.setUint32(4, height);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type: RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const chunks = [{ name: 'IHDR', data: ihdr }, { name: 'IDAT', data: deflated }];
    // 保留原图里的文本块(如角色卡 JSON tEXt),丢弃其它与像素相关的块
    for (const c of originalChunks) if (TEXT_CHUNKS.has(c.name)) chunks.push({ name: c.name, data: c.data });
    chunks.push({ name: 'IEND', data: new Uint8Array(0) });
    return Buffer.from(buildPng(chunks));
}

// ---------------------------------------------------------------------------
// LSB 读写
// ---------------------------------------------------------------------------

/** 单张图用 b 位/通道能塞下的最大字节数 */
export function lsbCapacity(width, height, bits) {
    return Math.floor((width * height * 3 * bits) / 8);
}

function u32be(n) {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** 构造待写入的容器:头部 + 载荷 */
function buildContainer(payload, fileName, bits) {
    if (bits < 1 || bits > 7 || !Number.isInteger(bits)) throw new Error('bits 必须是 1~7 的整数');
    const name = String(fileName || 'payload.bin')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .slice(0, 240) || 'payload.bin';
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > 255) throw new Error('文件名过长');
    return Buffer.concat([
        Buffer.from(MAGIC, 'ascii'),
        Buffer.from([VERSION, bits, nameBytes.length]),
        nameBytes,
        u32be(payload.length),
        Buffer.from(payload),
    ]);
}

function parseContainerHead(head) {
    if (head.length < 7) return null;
    if (Buffer.from(head.subarray(0, 4)).toString('ascii') !== MAGIC) return null;
    const version = head[4];
    const bits = head[5];
    const nameLen = head[6];
    if (version !== VERSION || bits < 1 || bits > 7) return null;
    return { version, bits, nameLen };
}

/** 把 rgba 的前若干个像素改成 LSB 隐写(返回新的 Uint8Array,不改原图) */
export function embedLsb(rgba, payload, fileName, bits) {
    if (bits < 1 || bits > 7 || !Number.isInteger(bits)) throw new Error('bits 必须是 1~7 的整数');
    const container = buildContainer(payload, fileName, bits);
    const totalBits = container.length * 8;
    const maxSlots = Math.floor(rgba.length / 4) * 3;
    if (totalBits > maxSlots * bits) {
        throw new Error(`容量不足:需要 ${container.length} 字节,该图用 ${bits} 位/通道最多只能存 ${Math.floor(maxSlots * bits / 8)} 字节(换更大的图或更小的 bits?)`);
    }
    const out = new Uint8Array(rgba); // 复制
    const mask = (1 << bits) - 1;
    const slotsNeeded = Math.ceil(totalBits / bits);
    const bitAt = (i) => (i < container.length * 8 ? (container[i >> 3] >> (7 - (i & 7))) & 1 : 0);
    for (let k = 0; k < slotsNeeded; k++) {
        const bytePos = Math.floor(k / 3) * 4 + (k % 3); // R,G,B 通道,跳过 alpha
        let val = 0;
        for (let j = 0; j < bits; j++) val = (val << 1) | bitAt(k * bits + j);
        out[bytePos] = (out[bytePos] & ~mask) | val;
    }
    return out;
}

/** 从 rgba 里读出 LSB 容器;bits 传 null 时自动探测 7..1 */
export function extractLsb(rgba, bits = null) {
    const maxSlots = Math.floor(rgba.length / 4) * 3;
    const maxBytes = Math.floor(maxSlots / 8); // 每字节至少 1 位时的上限(保守)

    // 带状态的流式读取器:连续字节必须从同一次读取里依次消费,不能各自从头读
    function makeReader(b) {
        const mask = (1 << b) - 1;
        let slot = 0, acc = 0, accBits = 0;
        const pull = () => {
            if (slot >= maxSlots) throw new Error('图片被截断:像素不足');
            const bytePos = Math.floor(slot / 3) * 4 + (slot % 3);
            slot++;
            return rgba[bytePos] & mask;
        };
        return {
            bytes(count) {
                if (count > maxBytes) throw new Error('数据超出图片容量');
                const out = new Uint8Array(count);
                for (let i = 0; i < count; i++) {
                    while (accBits < 8) { acc = (acc << b) | pull(); accBits += b; }
                    out[i] = (acc >>> (accBits - 8)) & 0xff;
                    accBits -= 8;
                    acc &= (1 << accBits) - 1;
                }
                return out;
            },
        };
    }

    const be32 = (buf, off) => ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;

    const tryParse = (b) => {
        const r = makeReader(b);
        const head = r.bytes(7);
        const parsed = parseContainerHead(head);
        if (!parsed) return null;
        const nb = r.bytes(parsed.nameLen + 4);          // 接续读:文件名 + 4 字节长度
        const name = Buffer.from(nb.subarray(0, parsed.nameLen)).toString('utf8');
        const len = be32(nb, parsed.nameLen);
        if (len > maxBytes - 7 - parsed.nameLen - 4) return null; // 长度荒谬,当噪声
        const payload = r.bytes(len);
        return { bits: parsed.bits, name, payload };
    };

    const candidates = bits !== null ? [bits] : [7, 6, 5, 4, 3, 2, 1];
    let lastError = null;
    for (const b of candidates) {
        try {
            const r2 = tryParse(b);
            if (r2 && r2.bits === b) return r2; // 头部自洽(存了 bits,双重校验)
        } catch (e) { lastError = e; }
    }
    throw new Error(lastError ? lastError.message : '没有找到 pcl1 格式的 LSB 载荷(该图可能没藏过,或已被压缩破坏)');
}
