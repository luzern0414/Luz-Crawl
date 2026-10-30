// Pure-JS replacement for
//   ffmpeg -i video -i audio -map 0:v:0 -map 1:a:0 -c copy -movflags +faststart -f mp4 out.mp4
// for ISO-BMFF (MP4 / DASH .m4s) inputs. No dependencies beyond node: built-ins.
//
// Progressive inputs  -> ftyp, moov (mvhd + video trak + audio trak), one mdat (video data, then audio data).
// Fragmented inputs   -> ftyp, moov (+ mvex/mehd/trex), then moof+mdat pairs interleaved by decode time.
// Box headers, moov and moof are held in memory; sample data is copied through fixed 1 MiB buffers.

import { open, rm } from 'node:fs/promises';
import path from 'node:path';

const MAX32 = 0xffffffff;
const ALL_ONES_64 = 0xffffffffffffffffn;
const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const IO_CHUNK = 1 << 20;
const MAX_META_BOX = 128 * 1024 * 1024; // sanity cap for a moov or moof read into memory

// Boxes whose payload is a plain list of child boxes and that we need to walk or edit.
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf']);
const TOP_LEVEL = new Set([
  'ftyp', 'styp', 'moov', 'moof', 'mdat', 'free', 'skip', 'wide', 'sidx', 'ssix',
  'pdin', 'uuid', 'meta', 'emsg', 'prft', 'mfra', 'pnot', 'junk',
]);
const ENCRYPTED_ENTRIES = new Set(['encv', 'enca', 'enct', 'encs', 'encm', 'drmi', 'drms']);
// Sample auxiliary information (and CENC sample data) refers to byte positions we do not carry over.
const AUX_INFO = new Set(['saio', 'saiz', 'senc']);

const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION = 0x000002;
const TFHD_DEFAULT_DURATION = 0x000008;
const TFHD_DEFAULT_SIZE = 0x000010;
const TFHD_DEFAULT_FLAGS = 0x000020;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;

const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_DURATION = 0x000100;
const TRUN_SIZE = 0x000200;
const TRUN_FLAGS = 0x000400;
const TRUN_CTO = 0x000800;

// ---------------------------------------------------------------- errors

function mediaError(code, message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  return err;
}

const muxFailed = (message, cause) => mediaError('mux_failed', message, cause);
const notIso = (message) => mediaError('unsupported_container', message);

// Buffer reads past the end of a malformed box surface as RangeError; report them as structural failures.
function asMuxError(err) {
  return err instanceof RangeError ? muxFailed(`malformed input: ${err.message}`, err) : err;
}

// ---------------------------------------------------------------- box primitives

// Decodes the box header at `at`. `available` is how many bytes the box may span (to EOF or parent end).
function decodeHeader(buf, at, available, where = at) {
  if (available < 8 || buf.length - at < 8) throw muxFailed(`truncated box header at offset ${where}`);
  let size = buf.readUInt32BE(at);
  const type = buf.toString('latin1', at + 4, at + 8);
  let hdr = 8;
  if (size === 1) {
    if (available < 16 || buf.length - at < 16) throw muxFailed(`truncated '${type}' header at offset ${where}`);
    size = Number(buf.readBigUInt64BE(at + 8));
    hdr = 16;
  } else if (size === 0) {
    size = available; // box extends to the end of the file / parent
  }
  if (type === 'uuid') hdr += 16;
  if (size < hdr) throw muxFailed(`malformed '${type}' box at offset ${where}`);
  if (size > available) throw muxFailed(`'${type}' box at offset ${where} extends beyond the end of its parent or file`);
  return { type, hdr, size };
}

function parseTree(buf, start = 0, end = buf.length) {
  const nodes = [];
  for (let pos = start; end - pos >= 8;) {
    const { type, hdr, size } = decodeHeader(buf, pos, end - pos);
    nodes.push(CONTAINERS.has(type)
      ? { type, children: parseTree(buf, pos + hdr, pos + size) }
      : { type, hdr, raw: buf.subarray(pos, pos + size) });
    pos += size;
  }
  return nodes;
}

function sizeOf(node) {
  return node.raw ? node.raw.length : node.children.reduce((n, c) => n + sizeOf(c), 8);
}

function serialize(node) {
  return node.raw ?? makeBox(node.type, Buffer.concat(node.children.map(serialize)));
}

function makeBox(type, body) {
  if (body.length + 8 > MAX32) throw muxFailed(`'${type}' box is too large`);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function makeFullBox(type, version, flags, body) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version << 24) | flags) >>> 0, 0);
  return makeBox(type, Buffer.concat([vf, body]));
}

const leaf = (raw) => ({ type: raw.toString('latin1', 4, 8), hdr: 8, raw });
const payloadOf = (node) => node.raw.subarray(node.hdr);
const childOf = (node, type) => node.children.find((c) => c.type === type);
const childrenOf = (node, type) => node.children.filter((c) => c.type === type);

function need(node, type) {
  const found = childOf(node, type);
  if (!found) throw muxFailed(`missing '${type}' box inside '${node.type}'`);
  return found;
}

function ensure(p, length, type) {
  if (p.length < length) throw muxFailed(`'${type}' box is truncated`);
}

function fullBox(node, maxVersion = 1) {
  const p = payloadOf(node);
  ensure(p, 4, node.type);
  if (p[0] > maxVersion) throw muxFailed(`unsupported '${node.type}' version ${p[0]}`);
  return { p, version: p[0], flags: p.readUIntBE(1, 3) };
}

const readU64 = (p, at) => Number(p.readBigUInt64BE(at));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
const exceeds32 = (n) => n != null && n >= MAX32;

// All-ones durations mean "unknown"; they are carried as null.
function readDuration(p, at, wide) {
  if (wide) {
    const v = p.readBigUInt64BE(at);
    return v === ALL_ONES_64 ? null : Number(v);
  }
  const v = p.readUInt32BE(at);
  return v === MAX32 ? null : v;
}

function writeDuration(buf, at, value, wide) {
  if (wide) buf.writeBigUInt64BE(value == null ? ALL_ONES_64 : BigInt(value), at);
  else buf.writeUInt32BE(value == null ? MAX32 : value, at);
  return at + (wide ? 8 : 4);
}

function writeTimes(buf, at, src, wide) {
  if (wide) {
    buf.writeBigUInt64BE(src.created, at);
    buf.writeBigUInt64BE(src.modified, at + 8);
    return at + 16;
  }
  buf.writeUInt32BE(Number(src.created), at);
  buf.writeUInt32BE(Number(src.modified), at + 4);
  return at + 8;
}

function rescale(value, from, to) {
  if (value == null || from === to) return value;
  return Number((BigInt(value) * BigInt(to) + BigInt(Math.floor(from / 2))) / BigInt(from));
}

// ---------------------------------------------------------------- header boxes

function parseMvhd(node) {
  const { p, version } = fullBox(node);
  const wide = version === 1;
  ensure(p, wide ? 112 : 100, 'mvhd');
  return {
    version,
    created: wide ? p.readBigUInt64BE(4) : BigInt(p.readUInt32BE(4)),
    modified: wide ? p.readBigUInt64BE(12) : BigInt(p.readUInt32BE(8)),
    timescale: p.readUInt32BE(wide ? 20 : 12),
    duration: readDuration(p, wide ? 24 : 16, wide),
    rest: p.subarray(wide ? 32 : 20, wide ? 108 : 96), // rate .. pre_defined (76 bytes)
  };
}

function buildMvhd(src, duration, nextTrackId) {
  const wide = src.version === 1 || exceeds32(duration);
  const body = Buffer.alloc(wide ? 108 : 96);
  let at = writeTimes(body, 0, src, wide);
  body.writeUInt32BE(src.timescale, at);
  at = writeDuration(body, at + 4, duration, wide);
  src.rest.copy(body, at);
  body.writeUInt32BE(nextTrackId, at + 76);
  return leaf(makeFullBox('mvhd', wide ? 1 : 0, 0, body));
}

function parseTkhd(node) {
  const { p, version, flags } = fullBox(node);
  const wide = version === 1;
  ensure(p, wide ? 96 : 84, 'tkhd');
  return {
    version,
    flags,
    created: wide ? p.readBigUInt64BE(4) : BigInt(p.readUInt32BE(4)),
    modified: wide ? p.readBigUInt64BE(12) : BigInt(p.readUInt32BE(8)),
    trackId: p.readUInt32BE(wide ? 20 : 12),
    duration: readDuration(p, wide ? 28 : 20, wide),
    tail: p.subarray(wide ? 36 : 24, wide ? 96 : 84), // layer, volume, matrix, width, height (60 bytes)
  };
}

function buildTkhd(src, trackId, duration) {
  const wide = src.version === 1 || exceeds32(duration);
  const body = Buffer.alloc(wide ? 92 : 80);
  let at = writeTimes(body, 0, src, wide);
  body.writeUInt32BE(trackId, at);
  at = writeDuration(body, at + 8, duration, wide); // track_ID + reserved
  src.tail.copy(body, at);
  return leaf(makeFullBox('tkhd', wide ? 1 : 0, src.flags, body));
}

function parseMdhd(node) {
  const { p, version } = fullBox(node);
  const wide = version === 1;
  ensure(p, wide ? 32 : 20, 'mdhd');
  return { timescale: p.readUInt32BE(wide ? 20 : 12), duration: readDuration(p, wide ? 24 : 16, wide) };
}

// Edit-list segment durations are in movie timescale; media_time stays in media timescale.
function rebuildElst(node, from, to) {
  const { p, version, flags } = fullBox(node);
  const wideIn = version === 1;
  const strideIn = wideIn ? 20 : 12;
  ensure(p, 8, 'elst');
  const count = p.readUInt32BE(4);
  ensure(p, 8 + count * strideIn, 'elst');
  const entries = [];
  for (let i = 0, o = 8; i < count; i++, o += strideIn) {
    entries.push({
      segment: rescale(wideIn ? readU64(p, o) : p.readUInt32BE(o), from, to),
      mediaTime: wideIn ? p.readBigInt64BE(o + 8) : BigInt(p.readInt32BE(o + 4)),
      rate: p.subarray(o + (wideIn ? 16 : 8), o + strideIn),
    });
  }
  const wide = wideIn || entries.some((e) => e.segment > MAX32);
  const stride = wide ? 20 : 12;
  const body = Buffer.alloc(4 + count * stride);
  body.writeUInt32BE(count, 0);
  entries.forEach((e, i) => {
    const o = 4 + i * stride;
    if (wide) {
      body.writeBigUInt64BE(BigInt(e.segment), o);
      body.writeBigInt64BE(e.mediaTime, o + 8);
    } else {
      body.writeUInt32BE(e.segment, o);
      body.writeInt32BE(Number(e.mediaTime), o + 4);
    }
    e.rate.copy(body, o + stride - 4);
  });
  return leaf(makeFullBox('elst', wide ? 1 : 0, flags, body));
}

function sampleEntryTypes(stsd) {
  const { p } = fullBox(stsd);
  ensure(p, 8, 'stsd');
  const count = p.readUInt32BE(4);
  const types = [];
  for (let i = 0, o = 8; i < count && p.length - o >= 8; i++) {
    const { type, size } = decodeHeader(p, o, p.length - o);
    types.push(type);
    o += size;
  }
  return types;
}

function describeTrack(trak) {
  const tkhd = parseTkhd(need(trak, 'tkhd'));
  const mdia = need(trak, 'mdia');
  const mdhd = parseMdhd(need(mdia, 'mdhd'));
  const hdlr = payloadOf(need(mdia, 'hdlr'));
  ensure(hdlr, 12, 'hdlr');
  const stbl = need(need(mdia, 'minf'), 'stbl');
  const entries = sampleEntryTypes(need(stbl, 'stsd'));
  return { trak, id: tkhd.trackId, tkhd, mdhd, handler: hdlr.toString('latin1', 8, 12), codec: entries[0] ?? null, entries, stbl };
}

// ---------------------------------------------------------------- sample tables (progressive)

function readChunkOffsets(stbl) {
  const node = childOf(stbl, 'stco') ?? childOf(stbl, 'co64');
  if (!node) throw muxFailed('chunk offset table (stco/co64) missing');
  const { p } = fullBox(node);
  ensure(p, 8, node.type);
  const count = p.readUInt32BE(4);
  const wide = node.type === 'co64';
  ensure(p, 8 + count * (wide ? 8 : 4), node.type);
  return Array.from({ length: count }, (_, i) => (wide ? readU64(p, 8 + i * 8) : p.readUInt32BE(8 + i * 4)));
}

function readStsc(stbl) {
  const { p } = fullBox(need(stbl, 'stsc'));
  ensure(p, 8, 'stsc');
  const count = p.readUInt32BE(4);
  ensure(p, 8 + count * 12, 'stsc');
  return Array.from({ length: count }, (_, i) => ({ first: p.readUInt32BE(8 + i * 12), perChunk: p.readUInt32BE(12 + i * 12) }));
}

function readSampleSizes(stbl) {
  const stsz = childOf(stbl, 'stsz');
  if (stsz) {
    const { p } = fullBox(stsz);
    ensure(p, 12, 'stsz');
    const constant = p.readUInt32BE(4);
    const count = p.readUInt32BE(8);
    if (constant) return { count, sum: (_, n) => constant * n };
    ensure(p, 12 + count * 4, 'stsz');
    return { count, sum: (start, n) => sumOver(start, n, (i) => p.readUInt32BE(12 + i * 4)) };
  }
  const stz2 = childOf(stbl, 'stz2');
  if (!stz2) throw muxFailed('sample size table (stsz/stz2) missing');
  const { p } = fullBox(stz2);
  ensure(p, 12, 'stz2');
  const bits = p[7];
  const count = p.readUInt32BE(8);
  if (![4, 8, 16].includes(bits)) throw muxFailed(`unsupported stz2 field size ${bits}`);
  ensure(p, 12 + Math.ceil((count * bits) / 8), 'stz2');
  const at = bits === 4 ? (i) => (p[12 + (i >> 1)] >> (i & 1 ? 0 : 4)) & 0xf
    : bits === 8 ? (i) => p[12 + i]
      : (i) => p.readUInt16BE(12 + i * 2);
  return { count, sum: (start, n) => sumOver(start, n, at) };
}

function sumOver(start, n, at) {
  let total = 0;
  for (let i = start; i < start + n; i++) total += at(i);
  return total;
}

function storedSampleCount(stbl) {
  const node = childOf(stbl, 'stsz') ?? childOf(stbl, 'stz2');
  if (!node) return 0;
  const { p } = fullBox(node);
  ensure(p, 12, node.type);
  return p.readUInt32BE(8);
}

// Byte range of every chunk of a progressive track, in chunk order.
function chunkRanges(stbl, fileSize, label) {
  const offsets = readChunkOffsets(stbl);
  const sizes = readSampleSizes(stbl);
  const stsc = readStsc(stbl);
  if (!offsets.length || !sizes.count || !stsc.length) throw muxFailed(`${label} track has no samples`);
  if (stsc[0].first !== 1) throw muxFailed(`${label} sample-to-chunk table does not start at chunk 1`);
  const ranges = new Array(offsets.length);
  let sample = 0;
  for (let e = 0; e < stsc.length; e++) {
    const next = e + 1 < stsc.length ? stsc[e + 1].first : offsets.length + 1;
    if (next <= stsc[e].first) throw muxFailed(`${label} sample-to-chunk table is not increasing`);
    for (let chunk = stsc[e].first; chunk < next && chunk <= offsets.length; chunk++) {
      const n = stsc[e].perChunk;
      if (sample + n > sizes.count) throw muxFailed(`${label} sample tables disagree (stsc covers more samples than stsz)`);
      const src = offsets[chunk - 1];
      const len = sizes.sum(sample, n);
      if (src + len > fileSize) throw muxFailed(`${label} chunk ${chunk} lies outside the file`);
      ranges[chunk - 1] = { src, len };
      sample += n;
    }
  }
  if (sample !== sizes.count || ranges.includes(undefined)) {
    throw muxFailed(`${label} sample tables disagree (stsc covers ${sample} of ${sizes.count} samples)`);
  }
  return ranges;
}

// Replaces the stco/co64 box of `stbl` with one holding `offsets`; co64 only when an offset needs 64 bits.
function rewriteChunkOffsets(stbl, offsets) {
  const wide = offsets.some((o) => o > MAX32);
  const body = Buffer.alloc(4 + offsets.length * (wide ? 8 : 4));
  body.writeUInt32BE(offsets.length, 0);
  offsets.forEach((o, i) => {
    if (wide) body.writeBigUInt64BE(BigInt(o), 4 + i * 8);
    else body.writeUInt32BE(o, 4 + i * 4);
  });
  const index = stbl.children.findIndex((c) => c.type === 'stco' || c.type === 'co64');
  if (index < 0) throw muxFailed('chunk offset table (stco/co64) missing');
  stbl.children[index] = leaf(makeFullBox(wide ? 'co64' : 'stco', 0, 0, body));
}

function packedOffsets(ranges, base) {
  let at = base;
  return ranges.map((r) => { const o = at; at += r.len; return o; });
}

function coalesce(ranges) {
  const out = [];
  for (const r of ranges) {
    const last = out.at(-1);
    if (last && last.src + last.len === r.src) last.len += r.len;
    else if (r.len) out.push({ src: r.src, len: r.len });
  }
  return out;
}

// ---------------------------------------------------------------- fragments

function readTrex(moov) {
  const map = new Map();
  const mvex = childOf(moov, 'mvex');
  for (const node of mvex ? childrenOf(mvex, 'trex') : []) {
    const { p } = fullBox(node);
    ensure(p, 24, 'trex');
    map.set(p.readUInt32BE(4), {
      sampleDescription: p.readUInt32BE(8), duration: p.readUInt32BE(12), size: p.readUInt32BE(16), flags: p.readUInt32BE(20),
    });
  }
  return map;
}

function buildTrex(t, trackId) {
  const body = Buffer.alloc(20);
  [trackId, t.sampleDescription, t.duration, t.size, t.flags].forEach((v, i) => body.writeUInt32BE(v, i * 4));
  return leaf(makeFullBox('trex', 0, 0, body));
}

function buildMehd(duration) {
  const wide = exceeds32(duration);
  const body = Buffer.alloc(wide ? 8 : 4);
  writeDuration(body, 0, duration ?? 0, wide);
  return leaf(makeFullBox('mehd', wide ? 1 : 0, 0, body));
}

function parseTfhd(node) {
  const { p, flags } = fullBox(node, 0);
  ensure(p, 8, 'tfhd');
  let at = 8;
  const take = (bit, len, read) => {
    if (!(flags & bit)) return undefined;
    ensure(p, at + len, 'tfhd');
    const value = read(at);
    at += len;
    return value;
  };
  const word = (o) => p.readUInt32BE(o);
  return {
    flags,
    trackId: p.readUInt32BE(4),
    baseDataOffset: take(TFHD_BASE_DATA_OFFSET, 8, (o) => readU64(p, o)),
    sampleDescription: take(TFHD_SAMPLE_DESCRIPTION, 4, word),
    defaultDuration: take(TFHD_DEFAULT_DURATION, 4, word),
    defaultSize: take(TFHD_DEFAULT_SIZE, 4, word),
    defaultFlags: take(TFHD_DEFAULT_FLAGS, 4, word),
  };
}

// Output fragments always use default-base-is-moof with an explicit trun data_offset.
function buildTfhd(t, trackId) {
  const flags = (t.flags & ~TFHD_BASE_DATA_OFFSET) | TFHD_DEFAULT_BASE_IS_MOOF;
  const fields = [trackId, t.sampleDescription, t.defaultDuration, t.defaultSize, t.defaultFlags].filter((v) => v !== undefined);
  const body = Buffer.alloc(fields.length * 4);
  fields.forEach((v, i) => body.writeUInt32BE(v, i * 4));
  return leaf(makeFullBox('tfhd', 0, flags, body));
}

function readTfdt(traf) {
  const node = childOf(traf, 'tfdt');
  if (!node) return undefined;
  const { p, version } = fullBox(node);
  ensure(p, version === 1 ? 12 : 8, 'tfdt');
  return version === 1 ? readU64(p, 4) : p.readUInt32BE(4);
}

function parseTrun(node) {
  const { p, version, flags } = fullBox(node);
  ensure(p, 8, 'trun');
  const count = p.readUInt32BE(4);
  let at = 8;
  let dataOffset;
  let firstFlags;
  if (flags & TRUN_DATA_OFFSET) { ensure(p, at + 4, 'trun'); dataOffset = p.readInt32BE(at); at += 4; }
  if (flags & TRUN_FIRST_SAMPLE_FLAGS) { ensure(p, at + 4, 'trun'); firstFlags = p.readUInt32BE(at); at += 4; }
  const stride = 4 * [TRUN_DURATION, TRUN_SIZE, TRUN_FLAGS, TRUN_CTO].filter((bit) => flags & bit).length;
  ensure(p, at + count * stride, 'trun');
  return { version, flags, count, dataOffset, firstFlags, stride, samples: p.subarray(at, at + count * stride) };
}

function buildTrun(t, dataOffset) {
  if (dataOffset > 0x7fffffff) throw muxFailed('fragment data offset does not fit in 32 bits');
  const head = Buffer.alloc(t.firstFlags === undefined ? 8 : 12);
  head.writeUInt32BE(t.count, 0);
  head.writeInt32BE(dataOffset, 4);
  if (t.firstFlags !== undefined) head.writeUInt32BE(t.firstFlags, 8);
  return leaf(makeFullBox('trun', t.version, t.flags | TRUN_DATA_OFFSET, Buffer.concat([head, t.samples])));
}

// Per-sample fields come in the order duration, size, flags, composition offset.
function trunTotals(trun, defaults) {
  const { flags, count, stride, samples } = trun;
  if (!count) return { bytes: 0, duration: 0 };
  const hasDuration = flags & TRUN_DURATION;
  const hasSize = flags & TRUN_SIZE;
  let bytes = hasSize ? 0 : count * defaults.size;
  let duration = hasDuration ? 0 : count * defaults.duration;
  if (hasDuration || hasSize) {
    for (let i = 0, o = 0; i < count; i++, o += stride) {
      if (hasDuration) duration += samples.readUInt32BE(o);
      if (hasSize) bytes += samples.readUInt32BE(o + (hasDuration ? 4 : 0));
    }
  }
  return { bytes, duration };
}

// Picks the selected track's trafs out of one moof and locates their sample data in the source file.
function fragmentFor(moof, moofStart, ctx) {
  let prevEnd = moofStart; // implicit base of the first traf; later trafs continue after the previous one's data
  const trafs = [];
  const runs = [];
  let dataLen = 0;
  let duration = 0;
  let samples = 0;
  let decodeTime;
  for (const traf of childrenOf(moof, 'traf')) {
    const tfhd = parseTfhd(need(traf, 'tfhd'));
    const mine = tfhd.trackId === ctx.trackId;
    const trex = ctx.trexById.get(tfhd.trackId);
    const defaults = { duration: tfhd.defaultDuration ?? trex?.duration, size: tfhd.defaultSize ?? trex?.size };
    const base = tfhd.baseDataOffset ?? (tfhd.flags & TFHD_DEFAULT_BASE_IS_MOOF ? moofStart : prevEnd);
    let cursor = base;
    const children = [];
    for (const node of traf.children) {
      if (node.type !== 'trun') {
        if (mine && !AUX_INFO.has(node.type)) children.push(node.type === 'tfhd' ? buildTfhd(tfhd, ctx.newId) : node);
        continue;
      }
      const trun = parseTrun(node);
      const totals = trunTotals(trun, defaults);
      const start = trun.dataOffset === undefined ? cursor : base + trun.dataOffset;
      cursor = start + totals.bytes;
      if (!mine) continue;
      if (!Number.isFinite(cursor) || !Number.isFinite(totals.duration)) {
        throw muxFailed(`${ctx.label}: cannot resolve sample sizes, durations or data position of a track fragment`);
      }
      if (start < 0 || cursor > ctx.fileSize) throw muxFailed(`${ctx.label}: fragment sample data lies outside the file`);
      children.push({ type: 'trun', trun, rel: dataLen });
      runs.push({ src: start, len: totals.bytes });
      dataLen += totals.bytes;
      duration += totals.duration;
      samples += trun.count;
    }
    prevEnd = cursor;
    if (mine) {
      trafs.push(children);
      decodeTime ??= readTfdt(traf);
    }
  }
  return samples ? { trafs, runs: coalesce(runs), dataLen, duration, decodeTime } : null;
}

async function collectFragments(input, track, newId, label) {
  if (storedSampleCount(track.stbl)) {
    throw muxFailed(`${label} input mixes samples in moov with movie fragments; not supported`);
  }
  const trexById = readTrex(input.moov);
  const ctx = { trackId: track.id, newId, trexById, fileSize: input.size, label };
  const items = [];
  let duration = 0;
  for (const box of input.boxes) {
    if (box.type !== 'moof') continue;
    const item = fragmentFor(await readTree(input.fh, box), box.start, ctx);
    if (!item) continue;
    item.time = (item.decodeTime ?? duration) / track.mdhd.timescale;
    item.input = input;
    duration += item.duration;
    items.push(item);
  }
  if (!items.length) throw muxFailed(`${label} input has no fragments for its ${track.handler} track`);
  const trex = trexById.get(track.id) ?? { sampleDescription: 1, duration: 0, size: 0, flags: 0 };
  return { items, duration, trex };
}

// Builds moof + mdat header for one output fragment; trun data offsets point into the following mdat.
function finishFragment(frag, sequence) {
  const mfhd = leaf(makeFullBox('mfhd', 0, 0, u32(sequence)));
  const mdatHead = mdatHeader(frag.dataLen);
  const build = (shift) => serialize({
    type: 'moof',
    children: [mfhd, ...frag.trafs.map((children) => ({
      type: 'traf',
      children: children.map((c) => (c.trun ? buildTrun(c.trun, shift + c.rel) : c)),
    }))],
  });
  const moofSize = build(0).length; // independent of the offset values
  return { moof: build(moofSize + mdatHead.length), mdatHead };
}

// Merge two decode-ordered fragment lists by start time without reordering either list.
function* interleave(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].time <= b[j].time)) yield a[i++];
    else yield b[j++];
  }
}

// ---------------------------------------------------------------- output layout

function mdatHeader(payloadLength) {
  const large = payloadLength + 8 > MAX32; // 64-bit largesize header
  const head = Buffer.alloc(large ? 16 : 8);
  head.writeUInt32BE(large ? 1 : payloadLength + 8, 0);
  head.write('mdat', 4, 'latin1');
  if (large) head.writeBigUInt64BE(BigInt(payloadLength + 16), 8);
  return head;
}

function buildFtyp(fragmented, videoCodec) {
  const major = fragmented ? 'iso5' : 'isom';
  const brands = fragmented ? ['iso5', 'iso6', 'isom', 'mp41'] : ['isom', 'iso2', 'mp41'];
  if (/^avc[13]$/.test(videoCodec)) brands.push('avc1');
  return makeBox('ftyp', Buffer.concat([Buffer.from(major, 'latin1'), u32(512), Buffer.from(brands.join(''), 'latin1')]));
}

function assignTrackIds(videoId, audioId) {
  const video = videoId && videoId < MAX32 - 1 ? videoId : 1;
  const audio = audioId && audioId !== video && audioId < MAX32 - 1 ? audioId : video + 1;
  return { video, audio, next: Math.max(video, audio) + 1 };
}

// Renumbers the track, rescales tkhd/elst durations into the output movie timescale, drops
// cross-track references (tref) and auxiliary-info offsets we cannot keep valid.
function prepareTrak(track, newId, movieDuration, fromTimescale, toTimescale) {
  track.stbl.children = track.stbl.children.filter((c) => !AUX_INFO.has(c.type));
  track.trak.children = track.trak.children
    .filter((c) => c.type !== 'tref')
    .map((c) => {
      if (c.type === 'tkhd') return buildTkhd(track.tkhd, newId, movieDuration);
      if (c.type === 'edts' && fromTimescale !== toTimescale) {
        return { type: 'edts', children: c.children.map((e) => (e.type === 'elst' ? rebuildElst(e, fromTimescale, toTimescale) : e)) };
      }
      return c;
    });
  return track.trak;
}

function trackSummary(track, id, duration) {
  const { timescale } = track.mdhd;
  return { id, codec: track.codec, timescale, duration, seconds: duration / timescale };
}

function planProgressive(video, v, audio, a) {
  const ids = assignTrackIds(v.id, a.id);
  const vRanges = chunkRanges(v.stbl, video.size, 'video');
  const aRanges = chunkRanges(a.stbl, audio.size, 'audio');
  const timescale = video.mvhd.timescale;
  const movieDuration = (track, srcTimescale) => (track.tkhd.duration
    ? rescale(track.tkhd.duration, srcTimescale, timescale)
    : rescale(track.mdhd.duration ?? 0, track.mdhd.timescale, timescale));
  const vDuration = movieDuration(v, video.mvhd.timescale);
  const aDuration = movieDuration(a, audio.mvhd.timescale);
  const moov = {
    type: 'moov',
    children: [
      buildMvhd(video.mvhd, Math.max(vDuration, aDuration), ids.next),
      prepareTrak(v, ids.video, vDuration, video.mvhd.timescale, timescale),
      prepareTrak(a, ids.audio, aDuration, audio.mvhd.timescale, timescale),
    ],
  };
  const ftyp = buildFtyp(false, v.codec);
  const vLength = vRanges.reduce((n, r) => n + r.len, 0);
  const aLength = aRanges.reduce((n, r) => n + r.len, 0);
  const mdatHead = mdatHeader(vLength + aLength);
  // Offsets depend on the moov size, which depends on stco vs co64; settle to a fixed point.
  let moovSize = -1;
  for (let round = 0; round < 4 && moovSize !== sizeOf(moov); round++) {
    moovSize = sizeOf(moov);
    const base = ftyp.length + moovSize + mdatHead.length;
    rewriteChunkOffsets(v.stbl, packedOffsets(vRanges, base));
    rewriteChunkOffsets(a.stbl, packedOffsets(aRanges, base + vLength));
  }
  if (moovSize !== sizeOf(moov)) throw muxFailed('chunk offsets did not settle');
  return {
    fragmented: false,
    bytes: ftyp.length + moovSize + mdatHead.length + vLength + aLength,
    steps: [
      { buffer: ftyp }, { buffer: serialize(moov) }, { buffer: mdatHead },
      { input: video, runs: coalesce(vRanges) }, { input: audio, runs: coalesce(aRanges) },
    ],
    video: trackSummary(v, ids.video, v.mdhd.duration ?? 0),
    audio: trackSummary(a, ids.audio, a.mdhd.duration ?? 0),
  };
}

async function planFragmented(video, v, audio, a) {
  const ids = assignTrackIds(v.id, a.id);
  const vFrags = await collectFragments(video, v, ids.video, 'video');
  const aFrags = await collectFragments(audio, a, ids.audio, 'audio');
  const timescale = video.mvhd.timescale;
  const vDuration = rescale(vFrags.duration, v.mdhd.timescale, timescale);
  const aDuration = rescale(aFrags.duration, a.mdhd.timescale, timescale);
  const total = Math.max(vDuration, aDuration);
  const moov = serialize({
    type: 'moov',
    children: [
      buildMvhd(video.mvhd, total, ids.next),
      prepareTrak(v, ids.video, vDuration, video.mvhd.timescale, timescale),
      prepareTrak(a, ids.audio, aDuration, audio.mvhd.timescale, timescale),
      { type: 'mvex', children: [buildMehd(total), buildTrex(vFrags.trex, ids.video), buildTrex(aFrags.trex, ids.audio)] },
    ],
  });
  const ftyp = buildFtyp(true, v.codec);
  const steps = [{ buffer: ftyp }, { buffer: moov }];
  let bytes = ftyp.length + moov.length;
  let sequence = 0;
  for (const frag of interleave(vFrags.items, aFrags.items)) {
    const { moof, mdatHead } = finishFragment(frag, ++sequence);
    steps.push({ buffer: moof }, { buffer: mdatHead }, { input: frag.input, runs: frag.runs });
    bytes += moof.length + mdatHead.length + frag.dataLen;
  }
  return {
    fragmented: true,
    bytes,
    steps,
    video: trackSummary(v, ids.video, vFrags.duration),
    audio: trackSummary(a, ids.audio, aFrags.duration),
  };
}

// ---------------------------------------------------------------- file I/O

async function readRange(fh, position, length) {
  const buf = Buffer.allocUnsafe(length);
  for (let off = 0; off < length;) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (!bytesRead) throw muxFailed('unexpected end of file');
    off += bytesRead;
  }
  return buf;
}

async function readTree(fh, box) {
  if (box.size > MAX_META_BOX) throw muxFailed(`'${box.type}' box at offset ${box.start} is too large to load`);
  return parseTree(await readRange(fh, box.start, box.size))[0];
}

function assertIsoStart(head, label) {
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) {
    throw notIso(`${label} is WebM/Matroska (EBML), not ISO-BMFF/MP4`);
  }
  if (head.length < 8 || !TOP_LEVEL.has(head.toString('latin1', 4, 8))) {
    throw notIso(`${label} is not an ISO-BMFF/MP4 file`);
  }
}

async function* walkTopLevel(fh, fileSize, label) {
  const head = Buffer.alloc(32);
  let pos = 0;
  while (fileSize - pos >= 8) {
    const { bytesRead } = await fh.read(head, 0, head.length, pos);
    const view = head.subarray(0, bytesRead);
    if (pos === 0) assertIsoStart(view, label);
    const box = decodeHeader(view, 0, fileSize - pos, pos);
    yield { ...box, start: pos };
    pos += box.size;
  }
  if (pos === 0) throw notIso(`${label} is too small to be an ISO-BMFF/MP4 file`);
}

async function openInput(file, label) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const boxes = [];
    for await (const box of walkTopLevel(fh, size, `${label} input`)) boxes.push(box);
    const moovBox = boxes.find((b) => b.type === 'moov');
    if (!moovBox) throw muxFailed(`${label} input has no moov box (missing init segment?)`);
    const moov = await readTree(fh, moovBox);
    const mvhd = parseMvhd(need(moov, 'mvhd'));
    if (!mvhd.timescale) throw muxFailed(`${label} input has a zero movie timescale`);
    return {
      fh, size, boxes, moov, mvhd,
      tracks: childrenOf(moov, 'trak').map(describeTrack),
      fragmented: boxes.some((b) => b.type === 'moof'),
    };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

function pickTrack(input, handler, label) {
  const track = input.tracks.find((t) => t.handler === handler);
  if (!track) throw muxFailed(`${label} input has no '${handler}' track`);
  if (!track.entries.length) throw muxFailed(`${label} track has no sample description`);
  const encrypted = track.entries.find((t) => ENCRYPTED_ENTRIES.has(t));
  if (encrypted) throw notIso(`${label} track is encrypted ('${encrypted}'); encrypted tracks are not supported`);
  if (!track.mdhd.timescale) throw muxFailed(`${label} track has a zero media timescale`);
  return track;
}

async function writeAll(fh, data) {
  for (let off = 0; off < data.length;) {
    const { bytesWritten } = await fh.write(data, off, data.length - off);
    off += bytesWritten;
  }
}

class Output {
  constructor(fh, limit) {
    this.fh = fh;
    this.limit = limit;
    this.buf = Buffer.allocUnsafe(IO_CHUNK);
    this.used = 0;
    this.bytes = 0;
  }

  async write(data) {
    this.bytes += data.length;
    if (this.bytes > this.limit) throw muxFailed(`output exceeds the ${this.limit}-byte limit`);
    if (this.used + data.length > this.buf.length) await this.flush();
    if (data.length >= this.buf.length) return writeAll(this.fh, data);
    data.copy(this.buf, this.used);
    this.used += data.length;
  }

  async flush() {
    if (!this.used) return;
    const n = this.used;
    this.used = 0;
    await writeAll(this.fh, this.buf.subarray(0, n));
  }
}

// Copies byte ranges out of one input through a single read-ahead window.
class Source {
  constructor(fh) {
    this.fh = fh;
    this.window = Buffer.allocUnsafe(IO_CHUNK);
    this.start = 0;
    this.length = 0;
  }

  async copyTo(out, position, length) {
    while (length > 0) {
      const at = position - this.start;
      if (at >= 0 && at < this.length) {
        const n = Math.min(length, this.length - at);
        await out.write(this.window.subarray(at, at + n));
        position += n;
        length -= n;
        continue;
      }
      const { bytesRead } = await this.fh.read(this.window, 0, this.window.length, position);
      if (!bytesRead) throw muxFailed('input ended before all sample data was copied');
      this.start = position;
      this.length = bytesRead;
    }
  }
}

// ---------------------------------------------------------------- public API

/**
 * Muxes the first video track of `videoFile` and the first audio track of `audioFile` into `outFile`.
 * Both inputs must be ISO-BMFF and either both progressive or both fragmented.
 * Durations in the result are in each track's media timescale (`seconds` is the same value in seconds).
 * Errors: code 'unsupported_container' (not ISO-BMFF, e.g. WebM; or encrypted tracks),
 * code 'mux_failed' (structural problems, mixed inputs, output above maxBytes). outFile is removed on failure.
 */
export async function muxAudioVideo(videoFile, audioFile, outFile, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const target = path.resolve(outFile);
  if (target === path.resolve(videoFile) || target === path.resolve(audioFile)) {
    throw muxFailed('output path must differ from the input paths');
  }
  let video;
  let audio;
  let outFh;
  try {
    video = await openInput(videoFile, 'video');
    audio = await openInput(audioFile, 'audio');
    const v = pickTrack(video, 'vide', 'video');
    const a = pickTrack(audio, 'soun', 'audio');
    if (video.fragmented !== audio.fragmented) {
      const kind = (input) => (input.fragmented ? 'fragmented' : 'progressive');
      throw muxFailed(`cannot mix a ${kind(video)} video input with a ${kind(audio)} audio input`);
    }
    const plan = video.fragmented ? await planFragmented(video, v, audio, a) : planProgressive(video, v, audio, a);
    if (plan.bytes > maxBytes) throw muxFailed(`output would be ${plan.bytes} bytes, above the ${maxBytes}-byte limit`);

    outFh = await open(outFile, 'w');
    const out = new Output(outFh, maxBytes);
    const sources = new Map([[video, new Source(video.fh)], [audio, new Source(audio.fh)]]);
    for (const step of plan.steps) {
      if (step.buffer) await out.write(step.buffer);
      else for (const run of step.runs) await sources.get(step.input).copyTo(out, run.src, run.len);
    }
    await out.flush();
    if (out.bytes !== plan.bytes) throw muxFailed(`wrote ${out.bytes} bytes, expected ${plan.bytes}`);
    const handle = outFh;
    outFh = null;
    await handle.close();
    return { file: outFile, bytes: out.bytes, video: plan.video, audio: plan.audio, fragmented: plan.fragmented };
  } catch (err) {
    if (outFh !== undefined) {
      await outFh?.close().catch(() => {});
      await rm(outFile, { force: true }).catch(() => {});
    }
    throw asMuxError(err);
  } finally {
    await video?.fh.close().catch(() => {});
    await audio?.fh.close().catch(() => {});
  }
}

/**
 * Quick probe. Never throws for non-ISO input (returns isoBmff: false); throws 'mux_failed' for a
 * corrupt ISO-BMFF structure. Scans top-level boxes only until the moov is found.
 */
export async function isoBmffInfo(file) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    let sawMoof = false;
    for await (const box of walkTopLevel(fh, size, file)) {
      if (box.type === 'moof') sawMoof = true;
      if (box.type !== 'moov') continue;
      const moov = await readTree(fh, box);
      return {
        isoBmff: true,
        fragmented: sawMoof || Boolean(childOf(moov, 'mvex')),
        tracks: childrenOf(moov, 'trak').map(describeTrack)
          .map(({ id, handler, codec, mdhd }) => ({ id, handler, codec, timescale: mdhd.timescale })),
      };
    }
    return { isoBmff: true, fragmented: sawMoof, tracks: [] };
  } catch (err) {
    if (err.code === 'unsupported_container') return { isoBmff: false, fragmented: false, tracks: [] };
    throw asMuxError(err);
  } finally {
    await fh.close();
  }
}

// Exposed for unit tests (box tree round-trips and the stco -> co64 rewrite).
export const _internal = Object.freeze({ parseTree, serialize, rewriteChunkOffsets });
