// ============================================================================
// png-cloak 核心库:纯 JS 实现 PNG 分块读写,零第三方依赖
// 原理:PNG = 8字节签名 + 一串 chunk。每个 chunk = 4B长度 + 4B类型名 + 数据 + 4B CRC32。
//       往 IEND 之前插入一个"自定义块",把任意文件(如图片)原样塞进去即可。
//       不认识该块的解码器按 PNG 规范会安全忽略它,所以图片照常显示。
// 本文件只包含浏览器/Node 都能用的纯逻辑;Node 的 CLI 入口见 cli.mjs。
// ============================================================================

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let CRC_TABLE = null;

/** 计算 CRC32(对若干 Uint8Array 分片连续计算,等价于拼接后一次计算) */
export function crc32(parts) {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    const list = Array.isArray(parts) ? parts : [parts];
    let crc = 0xffffffff;
    for (const part of list) {
        for (let i = 0; i < part.length; i++) {
            crc = CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** 判断一个字节串是不是合法 PNG(校验 8 字节签名) */
export function isPng(bytes) {
    if (!bytes || bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    return true;
}

/**
 * 把 PNG 文件解析成 chunk 数组。
 * @param {Uint8Array} bytes PNG 文件字节
 * @returns {{name:string, data:Uint8Array, offset:number}[]}
 */
export function parsePng(bytes) {
    if (!isPng(bytes)) throw new Error('不是合法的 PNG 文件(签名校验失败)');
    const chunks = [];
    let off = 8;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);            // 大端序长度
        if (off + 12 + len > bytes.length) throw new Error('PNG 结构损坏:块长度越界');
        const name = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        const data = bytes.subarray(off + 8, off + 8 + len);
        chunks.push({ name, data, offset: off });
        off += 12 + len;
        if (name === 'IEND') break;                 // IEND 之后的数据不属于 PNG(可能被清理)
    }
    if (!chunks.some((c) => c.name === 'IEND')) throw new Error('PNG 结构损坏:缺少 IEND 结束块');
    return chunks;
}

/** 把 chunk 数组重新拼装成完整 PNG 字节(签名 + 每块 长度/类型/数据/CRC32) */
export function buildPng(chunks) {
    let total = 8;
    for (const c of chunks) total += 12 + c.data.length;
    const out = new Uint8Array(total);
    for (let i = 0; i < 8; i++) out[i] = PNG_SIGNATURE[i];
    const view = new DataView(out.buffer);
    let off = 8;
    for (const c of chunks) {
        view.setUint32(off, c.data.length);
        off += 4;
        const nameBytes = new Uint8Array(4);
        for (let i = 0; i < 4; i++) nameBytes[i] = c.name.charCodeAt(i);
        out.set(nameBytes, off);
        off += 4;
        out.set(c.data, off);
        off += c.data.length;
        view.setUint32(off, crc32([nameBytes, c.data]));
        off += 4;
    }
    return out;
}

/** chunk 类型名必须是 4 个 ASCII 字母 */
export function isValidChunkName(name) {
    return typeof name === 'string' && /^[A-Za-z]{4}$/.test(name);
}

/**
 * 判断 chunk 名是否"可被不认识它的解码器安全忽略"。
 * PNG 命名规范:第1位小写=ancillary(可选块),第2位小写=private(私有),
 * 第4位小写=safe-to-copy(改图时允许复制)。全小写最稳妥。
 */
export function isSafeToIgnoreName(name) {
    if (!isValidChunkName(name)) return false;
    const lower = (i) => name.charCodeAt(i) >= 97 && name.charCodeAt(i) <= 122;
    return lower(0) && lower(3); // 至少是 ancillary + safe-to-copy
}

/** 删除同名块(用于重复隐藏时覆盖旧内容) */
export function removeChunksByName(chunks, name) {
    for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i].name === name) chunks.splice(i, 1);
    }
}

/** 在 IEND 之前插入一个新块;找不到 IEND 则追加到末尾 */
export function insertChunk(chunks, { name, data }) {
    const iend = chunks.findLastIndex((c) => c.name === 'IEND');
    const pos = iend >= 0 ? iend : chunks.length;
    chunks.splice(pos, 0, { name, data: new Uint8Array(data) });
    return pos;
}

/**
 * 用文件头魔数猜测字节是什么文件。
 * @returns {{kind:string, ext:string, label:string}}
 */
export function describeBytes(bytes) {
    const b = bytes;
    const has = (s, off = 0) => {
        for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false;
        return true;
    };
    if (isPng(b)) return { kind: 'png', ext: 'png', label: 'PNG 图片' };
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'jpg', ext: 'jpg', label: 'JPEG 图片' };
    if (has('GIF87a') || has('GIF89a')) return { kind: 'gif', ext: 'gif', label: 'GIF 图片' };
    if (has('RIFF') && has('WEBP', 8)) return { kind: 'webp', ext: 'webp', label: 'WebP 图片' };
    if ((b[0] === 0x50 && b[1] === 0x4b) && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
        return { kind: 'zip', ext: 'zip', label: 'ZIP 压缩包' };
    }
    if (has('%PDF')) return { kind: 'pdf', ext: 'pdf', label: 'PDF 文档' };
    return { kind: 'bin', ext: 'bin', label: '未知/二进制文件' };
}

/** 从 chunk 数组里找第一个能识别为图片(或文件)的"可疑隐藏块" */
export function detectHiddenChunk(chunks) {
    const ignored = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tEXt', 'zTXt', 'iTXt', 'bKGD', 'cHRM', 'gAMA', 'hIST', 'iCCP', 'pHYs', 'sBIT', 'sPLT', 'sRGB', 'tIME', 'eXIf', 'acTL', 'fcTL', 'fdAT']);
    for (const c of chunks) {
        if (ignored.has(c.name)) continue;
        const meta = describeBytes(c.data);
        if (meta.kind !== 'bin') return { ...c, meta };
    }
    return null;
}
