#!/usr/bin/env node
// ============================================================================
// png-cloak CLI —— 把文件(通常是图片)隐藏进 PNG,以及提取出来
// 零依赖,需要 Node.js 18+(只用内置 fs/zlib)。用法见 README.md 或 --help。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
    isPng, parsePng, buildPng, isValidChunkName, isSafeToIgnoreName,
    removeChunksByName, insertChunk, describeBytes, detectHiddenChunk, crc32,
} from './core.mjs';
import {
    decodePngToRgba, encodeRgbaToPng, embedLsb, extractLsb, lsbCapacity,
} from './lsb.mjs';

const DEFAULT_CHUNK = 'hide';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const USAGE = `
png-cloak —— 在 PNG 里隐藏文件 / 提取隐藏文件(零依赖 Node 工具)

两种引擎:
  A. 容器隐写(hide / extract):在 PNG 末尾加自定义数据块,像素一个字节都不动。
  B. LSB 像素隐写(hide-lsb / extract-lsb):数据写进像素低位,肉眼看不出,
     必须用 PNG 无损保存(转 JPEG 会丢)。

用法:
  node cli.mjs hide        <载体.png> <秘密文件>  [-o 输出.png] [-n 块名] [--no-check]
  node cli.mjs extract     <带隐藏的.png>          [-o 提取文件] [-n 块名]
  node cli.mjs hide-lsb    <载体.png> <秘密文件>  [-o 输出.png] [-b 1-7] [--no-check]
  node cli.mjs extract-lsb <带隐藏的.png>          [-o 提取文件] [-b 1-7]
  node cli.mjs list        <png文件>               (查看块)
  node cli.mjs probe       <png文件>               (查看像素信息 + 是否有 LSB 载荷)
  node cli.mjs help

参数:
  -o, --output <路径>  输出文件路径(缺省自动生成)
  -n, --name   <块名>  容器引擎的块名,4 个英文字母,默认 "${DEFAULT_CHUNK}"
  -b, --bits   <1-7>   LSB 引擎每通道位数,默认 3(越大容量越大、痕迹越明显)
      --no-check       跳过自检(默认自动做,LSB 隐藏后还会回读比对)
  -h, --help           显示帮助

说明:
  * hide/extract:把秘密文件原始字节作为新 chunk 插到 IEND 前,不动像素与原有块。
  * hide-lsb/extract-lsb:参考"无影坦克"思路,高位在前写入每像素 RGB 的低 b 位;
    容量 = 宽×高×3×b/8 字节;重新编码时会保留角色卡等 tEXt 文本块。
  * 两种引擎可组合:先做 LSB(改像素),再做容器(加块)——互不干扰。
`;

function parseArgs(argv) {
    const args = { opts: {}, positional: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-o' || a === '--output') args.opts.output = argv[++i];
        else if (a === '-n' || a === '--name') args.opts.name = argv[++i];
        else if (a === '-b' || a === '--bits') args.opts.bits = argv[++i];
        else if (a === '--no-check') args.opts.noCheck = true;
        else if (a === '-h' || a === '--help') args.opts.help = true;
        else if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
        else args.positional.push(a);
    }
    return args;
}

function parseBits(raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 7) throw new Error('bits 必须是 1~7 的整数');
    return n;
}

function readFile(p) {
    try {
        return fs.readFileSync(p);
    } catch (e) {
        throw new Error(`无法读取文件 ${p}: ${e.message}`);
    }
}

function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// 结构自检:签名 + 逐块 CRC + 像素流(zlib)解压长度验证 —— 证明输出仍是合法 PNG
// ---------------------------------------------------------------------------
function structureReport(bytes) {
    const lines = [];
    const chunks = parsePng(bytes); // 签名/边界检查已包含在内
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const c of chunks) {
        const stored = view.getUint32(c.offset + 8 + c.data.length);
        const nameBytes = new Uint8Array([c.name.charCodeAt(0), c.name.charCodeAt(1), c.name.charCodeAt(2), c.name.charCodeAt(3)]);
        const calc = crc32([nameBytes, c.data]);
        if (calc !== stored) lines.push(`  ✗ ${c.name} 块 CRC 校验失败`);
    }
    if (!lines.some((l) => l.includes('✗'))) lines.push('  ✓ 所有块 CRC32 校验通过');

    const ihdr = chunks.find((c) => c.name === 'IHDR');
    const idats = chunks.filter((c) => c.name === 'IDAT');
    if (ihdr && idats.length) {
        const w = new DataView(ihdr.data.buffer, ihdr.data.byteOffset).getUint32(0);
        const h = new DataView(ihdr.data.buffer, ihdr.data.byteOffset).getUint32(4);
        const bitDepth = ihdr.data[8];
        const colorType = ihdr.data[9];
        const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
        const bytesPerSample = bitDepth === 16 ? 2 : 1;
        const raw = zlib.inflateSync(Buffer.concat(idats.map((c) => Buffer.from(c.data))));
        const expected = h * (1 + w * channels * bytesPerSample);
        lines.push(`  ✓ 像素流可解压: ${w}x${h} colorType=${colorType} 解压 ${fmtBytes(raw.length)} = 理论值 ${fmtBytes(expected)} (${raw.length === expected ? '吻合' : '不一致!'})`);
    }
    return lines;
}

// ---------------------------------------------------------------------------
// 各子命令
// ---------------------------------------------------------------------------
function cmdHide(fileIn, secretIn, output, name, doCheck) {
    const carrier = readFile(fileIn);
    if (!isPng(carrier)) throw new Error(`载体不是 PNG: ${fileIn}`);
    const secret = readFile(secretIn);
    if (!isValidChunkName(name)) throw new Error(`块名 "${name}" 非法:必须是 4 个英文字母`);
    if (!isSafeToIgnoreName(name)) {
        console.warn(`提示:块名 "${name}" 首/末字母不是小写,某些严格的解码器可能不认识。建议用全小写如 "${DEFAULT_CHUNK}"。`);
    }

    const secretMeta = describeBytes(secret);
    const chunks = parsePng(carrier);
    const beforeCount = chunks.length;
    removeChunksByName(chunks, name);       // 重复隐藏时覆盖旧内容
    insertChunk(chunks, { name, data: secret });
    const out = buildPng(chunks);

    const finalPath = output || `hidden_${path.basename(fileIn)}`;
    fs.writeFileSync(finalPath, out);

    console.log(`✓ 已隐藏: ${fmtBytes(secret.length)} 的 ${secretMeta.label}  →  新块 "${name}"`);
    console.log(`  载体: ${fmtBytes(carrier.length)} → ${fmtBytes(out.length)}  (chunk ${beforeCount} → ${chunks.length} 个)`);
    console.log(`  输出: ${finalPath}`);
    console.log('  原有块(含角色卡 tEXt/像素)均原样保留。');
    if (doCheck) {
        console.log('结构自检:');
        for (const l of structureReport(out)) console.log(l);
    }
}

function cmdExtract(fileIn, output, name) {
    const bytes = readFile(fileIn);
    if (!isPng(bytes)) throw new Error(`不是 PNG 文件: ${fileIn}`);
    const chunks = parsePng(bytes);
    console.log(`文件块: ${chunks.map((c) => c.name).join(', ')}`);

    let target = null;
    if (name) {
        target = chunks.find((c) => c.name === name) || null;
        if (!target) throw new Error(`找不到名为 "${name}" 的块。可用 node cli.mjs list "${fileIn}" 查看所有块。`);
    } else {
        target = detectHiddenChunk(chunks);
        if (!target) throw new Error('没有自动识别出隐藏内容(无图片魔数的自定义块)。可用 -n 指定块名,或用 list 查看。');
        console.log(`自动识别到隐藏块: "${target.name}"`);
    }

    const data = Buffer.from(target.data);
    const meta = describeBytes(data);
    const finalPath = output || `extracted_${path.basename(fileIn, path.extname(fileIn))}.${meta.ext}`;
    fs.writeFileSync(finalPath, data);

    console.log(`✓ 提取出 ${fmtBytes(data.length)} 的 ${meta.label} → ${finalPath}`);
    if (meta.kind === 'png') {
        console.log('结构自检(提取物):');
        for (const l of structureReport(data)) console.log(l);
    }
}

function cmdList(fileIn) {
    const bytes = readFile(fileIn);
    if (!isPng(bytes)) throw new Error(`不是 PNG 文件: ${fileIn}`);
    const chunks = parsePng(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    console.log(`文件: ${fileIn} (${fmtBytes(bytes.length)})`);
    console.log('块列表:');
    for (const c of chunks) {
        const stored = view.getUint32(c.offset + 8 + c.data.length);
        const meta = describeBytes(c.data);
        const mark = meta.kind !== 'bin' ? ` ← 可能是隐藏内容(${meta.label})` : '';
        console.log(`  [${c.name}] ${fmtBytes(c.data.length)}  crc=${stored.toString(16).padStart(8, '0')}${mark}`);
    }
}

function sanitizeName(name) {
    return String(name || 'payload.bin').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 240) || 'payload.bin';
}

function cmdHideLsb(fileIn, secretIn, output, bits, doCheck) {
    const carrier = readFile(fileIn);
    if (!isPng(carrier)) throw new Error(`载体不是 PNG: ${fileIn}`);
    const secret = readFile(secretIn);
    const secretMeta = describeBytes(secret);

    const { width, height, rgba } = decodePngToRgba(carrier);
    const capacity = lsbCapacity(width, height, bits);
    if (secret.length > capacity) {
        throw new Error(`容量不足:秘密文件 ${fmtBytes(secret.length)},该图用 ${bits} 位/通道最多存 ${fmtBytes(capacity)}(${width}x${height})。可换更大的图或把 -b 调大。`);
    }

    const newRgba = embedLsb(rgba, secret, path.basename(secretIn), bits);
    const originalChunks = parsePng(carrier);
    const out = encodeRgbaToPng(width, height, newRgba, originalChunks);

    const finalPath = output || `lsb_${path.basename(fileIn)}`;
    fs.writeFileSync(finalPath, out);

    console.log(`✓ 已 LSB 隐写: ${fmtBytes(secret.length)} 的 ${secretMeta.label}(${bits} 位/通道)`);
    console.log(`  图片 ${width}x${height},容量 ${fmtBytes(capacity)} → 文件 ${fmtBytes(carrier.length)} → ${fmtBytes(out.length)}`);
    console.log(`  输出: ${finalPath}`);
    console.log('  角色卡等 tEXt 文本块已保留。');
    if (doCheck) {
        console.log('结构自检:');
        for (const l of structureReport(out)) console.log(l);
        const back = extractLsb(decodePngToRgba(out).rgba, bits);
        const ok = Buffer.compare(Buffer.from(back.payload), secret) === 0;
        console.log(`  回读比对: ${ok ? '✓ 提取结果与原文完全一致' : '✗ 不一致!'}`);
    }
}

function cmdExtractLsb(fileIn, output, bits) {
    const bytes = readFile(fileIn);
    if (!isPng(bytes)) throw new Error(`不是 PNG 文件: ${fileIn}`);
    const { width, height, rgba } = decodePngToRgba(bytes);
    const r = extractLsb(rgba, bits);
    const meta = describeBytes(r.payload);
    const base = sanitizeName(r.name).replace(/\.[^.]+$/, '') || 'extracted';
    const finalPath = output || `${base}.${meta.ext}`;
    fs.writeFileSync(finalPath, Buffer.from(r.payload));
    console.log(`✓ 提取出 ${fmtBytes(r.payload.length)} 的 ${meta.label}(LSB ${r.bits} 位/通道,原文件名: ${r.name})`);
    console.log(`  图片 ${width}x${height} → ${finalPath}`);
    if (meta.kind === 'png') {
        console.log('结构自检(提取物):');
        for (const l of structureReport(r.payload)) console.log(l);
    }
}

function cmdProbe(fileIn) {
    const bytes = readFile(fileIn);
    if (!isPng(bytes)) throw new Error(`不是 PNG 文件: ${fileIn}`);
    const { width, height, rgba } = decodePngToRgba(bytes);
    console.log(`图片: ${width}x${height} 像素 (${fmtBytes(bytes.length)})`);
    for (const b of [1, 3, 7]) {
        console.log(`  LSB 容量(${b} 位/通道): ${fmtBytes(lsbCapacity(width, height, b))}`);
    }
    try {
        const r = extractLsb(rgba, null);
        console.log(`  检测到 LSB 载荷: ${r.bits} 位/通道,原文件名 "${r.name}",${fmtBytes(r.payload.length)}`);
    } catch (e) {
        console.log('  未检测到 pcl1 格式的 LSB 载荷');
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
function main() {
    const { opts, positional } = parseArgs(process.argv.slice(2));
    if (opts.help || positional.length === 0) {
        console.log(USAGE);
        return;
    }
    const cmd = positional[0];
    const args = positional.slice(1);
    const name = opts.name || DEFAULT_CHUNK;
    const doCheck = !opts.noCheck;

    switch (cmd) {
        case 'hide': {
            if (args.length < 2) throw new Error('hide 需要: <载体.png> <秘密文件>');
            cmdHide(args[0], args[1], opts.output, name, doCheck);
            break;
        }
        case 'extract': {
            if (args.length < 1) throw new Error('extract 需要: <png文件>');
            cmdExtract(args[0], opts.output, opts.name); // 未指定 -n 时自动识别
            break;
        }
        case 'list': {
            if (args.length < 1) throw new Error('list 需要: <png文件>');
            cmdList(args[0]);
            break;
        }
        case 'probe': {
            if (args.length < 1) throw new Error('probe 需要: <png文件>');
            cmdProbe(args[0]);
            break;
        }
        case 'hide-lsb': {
            if (args.length < 2) throw new Error('hide-lsb 需要: <载体.png> <秘密文件>');
            cmdHideLsb(args[0], args[1], opts.output, parseBits(opts.bits ?? 3), doCheck);
            break;
        }
        case 'extract-lsb': {
            if (args.length < 1) throw new Error('extract-lsb 需要: <png文件>');
            cmdExtractLsb(args[0], opts.output, opts.bits !== undefined ? parseBits(opts.bits) : null);
            break;
        }
        case 'help': {
            console.log(USAGE);
            break;
        }
        default:
            throw new Error(`未知子命令: ${cmd}\n${USAGE}`);
    }
}

try {
    main();
} catch (e) {
    console.error(`[错误] ${e.message}`);
    process.exitCode = 1;
}
