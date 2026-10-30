import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { muxAudioVideo, isoBmffInfo, _internal } from '../lib/media-mux.mjs';

// ---------------------------------------------------------------- box writers

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const str = (s) => Buffer.from(s, 'latin1');
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), str(type), body]); };
const full = (type, version, flags, ...parts) => box(type, u32(((version << 24) | flags) >>> 0), ...parts);

const MATRIX = Buffer.concat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32));
const ftyp = (major, brands) => box('ftyp', str(major), u32(0), str(brands.join('')));
const mvhd = (timescale, duration, nextId) => full('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration),
  u32(0x10000), u16(0x100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(nextId));
const tkhd = (id, duration, volume) => full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(duration),
  Buffer.alloc(8), u16(0), u16(0), u16(volume), u16(0), MATRIX, u32(64 << 16), u32(48 << 16));
const mdhd = (timescale, duration) => full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
const hdlr = (handler) => full('hdlr', 0, 0, u32(0), str(handler), Buffer.alloc(12), str('test\0'));
const avc1 = () => box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(64), u16(48), u32(0x480000), u32(0x480000),
  u32(0), u16(1), Buffer.alloc(32), u16(0x18), u16(0xffff), box('avcC', Buffer.from([1, 0x64, 0, 0x1f, 0xff, 0xe0, 0])));
const mp4a = (format = 'mp4a') => box(format, Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2), u16(16), u16(0), u16(0), u32(44100 * 65536));

// Recognisable, distinct payload per sample.
const makeSamples = (tag, count, base) => Array.from({ length: count }, (_, i) => Buffer.from(`<${tag}:${i}>`.padEnd(base + i * 3, tag)));

function stblBox(t, offsets, offsetType) {
  const stsc = [];
  t.chunks.forEach((n, i) => { if (!stsc.length || stsc.at(-1)[1] !== n) stsc.push([i + 1, n, 1]); });
  const n = t.samples.length;
  return box('stbl',
    full('stsd', 0, 0, u32(1), t.entry ?? (t.handler === 'vide' ? avc1() : mp4a())),
    full('stts', 0, 0, ...(n ? [u32(1), u32(n), u32(t.delta)] : [u32(0)])),
    full('stsc', 0, 0, u32(stsc.length), ...stsc.flat().map(u32)),
    full('stsz', 0, 0, u32(0), u32(n), ...t.samples.map((s) => u32(s.length))),
    offsetType === 'co64'
      ? full('co64', 0, 0, u32(offsets.length), ...offsets.map(u64))
      : full('stco', 0, 0, u32(offsets.length), ...offsets.map(u32)));
}

function trakBox(t, movieTimescale, offsets = [], offsetType = 'stco') {
  const mediaDuration = t.samples.length * t.delta;
  const video = t.handler === 'vide';
  return box('trak',
    tkhd(t.id, Math.round((mediaDuration * movieTimescale) / t.timescale), video ? 0 : 0x100),
    t.edit ? box('edts', full('elst', 0, 0, u32(1), u32(t.edit.segment), i32(t.edit.mediaTime), u16(1), u16(0))) : Buffer.alloc(0),
    box('mdia', mdhd(t.timescale, mediaDuration), hdlr(t.handler),
      box('minf', video ? full('vmhd', 0, 1, Buffer.alloc(8)) : full('smhd', 0, 0, Buffer.alloc(4)),
        box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
        stblBox(t, offsets, offsetType))));
}

// Progressive MP4: chunks optionally interleaved across tracks; moov before or after mdat;
// mdat header plain, 64-bit largesize, or size 0 (to EOF, only when mdat is last).
function progressiveFile({ movieTimescale, tracks, moovFirst = true, mdat = 'plain', offsetType = 'stco', interleave = false }) {
  const chunkData = tracks.map((t) => { let s = 0; return t.chunks.map((n) => Buffer.concat(t.samples.slice(s, (s += n)))); });
  const order = [];
  if (interleave) {
    for (let c = 0; c < Math.max(...chunkData.map((x) => x.length)); c++) {
      chunkData.forEach((chunks, ti) => { if (c < chunks.length) order.push([ti, c]); });
    }
  } else {
    chunkData.forEach((chunks, ti) => chunks.forEach((_, c) => order.push([ti, c])));
  }
  const rel = tracks.map(() => []);
  let at = 0;
  for (const [ti, c] of order) { rel[ti][c] = at; at += chunkData[ti][c].length; }
  const payload = Buffer.concat(order.map(([ti, c]) => chunkData[ti][c]));
  const head = mdat === 'large' ? Buffer.concat([u32(1), str('mdat'), u64(payload.length + 16)])
    : mdat === 'to-eof' ? Buffer.concat([u32(0), str('mdat')])
      : Buffer.concat([u32(payload.length + 8), str('mdat')]);
  const ft = ftyp('isom', ['isom', 'iso2', 'avc1', 'mp41']);
  const duration = Math.max(...tracks.map((t) => Math.round((t.samples.length * t.delta * movieTimescale) / t.timescale)));
  const moov = (base) => box('moov', mvhd(movieTimescale, duration, Math.max(...tracks.map((t) => t.id)) + 1),
    ...tracks.map((t, i) => trakBox(t, movieTimescale, rel[i].map((r) => r + base), offsetType)));
  if (moovFirst) {
    const moovLength = moov(0).length;
    return Buffer.concat([ft, moov(ft.length + moovLength + head.length), head, payload]);
  }
  return Buffer.concat([ft, head, payload, moov(ft.length + head.length)]);
}

// Fragmented MP4 (init + media segments in one file). Per-fragment data addressing modes:
//   'moof'     default-base-is-moof + trun data_offset (DASH norm)
//   'base'     tfhd base_data_offset (absolute) + default duration, trun without data_offset
//   'implicit' no tfhd base flags, trun data_offset relative to the moof (first traf)
function fragmentedFile({ id, handler, timescale, delta, fragments, modes = ['moof'], rich = false, extras = false }) {
  const t = { id, handler, timescale, delta, samples: [], chunks: [] };
  const parts = [
    ftyp('iso5', ['iso5', 'iso6', 'mp41']),
    box('moov', mvhd(1000, 0, id + 1), trakBox(t, 1000),
      box('mvex', full('mehd', 0, 0, u32(0)), full('trex', 0, 0, u32(id), u32(1), u32(delta), u32(0), u32(0)))),
  ];
  if (extras) parts.push(full('sidx', 0, 0, u32(id), u32(timescale), u32(0), u32(0), u16(0), u16(0)));
  let length = parts.reduce((n, b) => n + b.length, 0);
  let time = 0;
  fragments.forEach((samples, k) => {
    if (extras) {
      const styp = box('styp', str('msdh'), u32(0), str('msdhmsix'));
      parts.push(styp);
      length += styp.length;
    }
    const mode = modes[k % modes.length];
    const moof = (offset) => {
      let tfhd;
      let trun;
      if (mode === 'base') {
        tfhd = full('tfhd', 0, 0x01 | 0x08, u32(id), u64(offset), u32(delta));
        trun = full('trun', 0, 0x200, u32(samples.length), ...samples.map((s) => u32(s.length)));
      } else if (rich) {
        tfhd = full('tfhd', 0, 0x020000, u32(id));
        trun = full('trun', 1, 0x001 | 0x004 | 0x100 | 0x200 | 0x800, u32(samples.length), i32(offset), u32(0x02000000),
          ...samples.flatMap((s, i) => [u32(delta), u32(s.length), i32(i % 2 ? 1024 : -512)]));
      } else {
        tfhd = full('tfhd', 0, mode === 'moof' ? 0x020000 : 0, u32(id));
        trun = full('trun', 0, 0x001 | 0x200, u32(samples.length), i32(offset), ...samples.map((s) => u32(s.length)));
      }
      return box('moof', full('mfhd', 0, 0, u32(k + 1)), box('traf', tfhd, full('tfdt', 1, 0, u64(time)), trun));
    };
    const draft = moof(0).length;
    const real = moof(mode === 'base' ? length + draft + 8 : draft + 8);
    const data = Buffer.concat(samples);
    parts.push(real, box('mdat', data));
    length += real.length + 8 + data.length;
    time += samples.length * delta;
  });
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- independent reader for assertions

function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  for (let p = start; p + 8 <= end;) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    assert.ok(size >= hdr && p + size <= end, `bad '${type}' box at ${p}`);
    out.push({ type, start: p, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const kids = (buf, b) => boxes(buf, b.body, b.end);
function one(buf, b, type) {
  const found = kids(buf, b).filter((k) => k.type === type);
  assert.equal(found.length, 1, `expected exactly one '${type}'`);
  return found[0];
}
const dig = (buf, b, ...types) => types.reduce((cur, t) => one(buf, cur, t), b);
const flagsOf = (buf, b) => buf.readUInt32BE(b.body) & 0xffffff;

function progressiveSamples(buf, trak) {
  const stbl = dig(buf, trak, 'mdia', 'minf', 'stbl');
  const k = kids(buf, stbl);
  const stsz = k.find((b) => b.type === 'stsz');
  const constant = buf.readUInt32BE(stsz.body + 4);
  const sizes = Array.from({ length: buf.readUInt32BE(stsz.body + 8) }, (_, i) => constant || buf.readUInt32BE(stsz.body + 12 + i * 4));
  const stsc = k.find((b) => b.type === 'stsc');
  const entries = Array.from({ length: buf.readUInt32BE(stsc.body + 4) }, (_, i) => ({
    first: buf.readUInt32BE(stsc.body + 8 + i * 12), perChunk: buf.readUInt32BE(stsc.body + 12 + i * 12),
  }));
  const co = k.find((b) => b.type === 'stco' || b.type === 'co64');
  const wide = co.type === 'co64';
  const offsets = Array.from({ length: buf.readUInt32BE(co.body + 4) },
    (_, i) => (wide ? Number(buf.readBigUInt64BE(co.body + 8 + i * 8)) : buf.readUInt32BE(co.body + 8 + i * 4)));
  const samples = [];
  const ranges = [];
  let s = 0;
  offsets.forEach((offset, c) => {
    let pos = offset;
    for (let j = 0; j < entries.findLast((e) => e.first <= c + 1).perChunk; j++) {
      ranges.push([pos, pos + sizes[s]]);
      samples.push(buf.subarray(pos, pos + sizes[s]));
      pos += sizes[s++];
    }
  });
  return { samples, ranges, offsetType: co.type };
}

// Resolves every trun sample of the output and checks it lies inside the mdat right after its moof.
function fragmentSamples(buf) {
  const top = boxes(buf);
  const moov = top.find((b) => b.type === 'moov');
  const trex = new Map(kids(buf, dig(buf, moov, 'mvex')).filter((b) => b.type === 'trex')
    .map((b) => [buf.readUInt32BE(b.body + 4), { size: buf.readUInt32BE(b.body + 16) }]));
  const byTrack = new Map();
  const sequence = [];
  const order = [];
  const tfhdFlags = [];
  top.forEach((m, index) => {
    if (m.type !== 'moof') return;
    const mdat = top[index + 1];
    assert.equal(mdat?.type, 'mdat', 'every moof is followed by its mdat');
    sequence.push(buf.readUInt32BE(dig(buf, m, 'mfhd').body + 4));
    for (const traf of kids(buf, m).filter((b) => b.type === 'traf')) {
      const th = dig(buf, traf, 'tfhd');
      const flags = flagsOf(buf, th);
      const id = buf.readUInt32BE(th.body + 4);
      tfhdFlags.push(flags);
      order.push(id);
      let o = th.body + 8;
      let base = m.start;
      if (flags & 0x01) { base = Number(buf.readBigUInt64BE(o)); o += 8; }
      if (flags & 0x02) o += 4;
      if (flags & 0x08) o += 4;
      let defaultSize = trex.get(id).size;
      if (flags & 0x10) defaultSize = buf.readUInt32BE(o);
      for (const tr of kids(buf, traf).filter((b) => b.type === 'trun')) {
        const tf = flagsOf(buf, tr);
        const count = buf.readUInt32BE(tr.body + 4);
        let p = tr.body + 8;
        assert.ok(tf & 0x001, 'output trun carries a data_offset');
        let pos = base + buf.readInt32BE(p);
        p += 4;
        if (tf & 0x004) p += 4;
        for (let i = 0; i < count; i++) {
          if (tf & 0x100) p += 4;
          let size = defaultSize;
          if (tf & 0x200) { size = buf.readUInt32BE(p); p += 4; }
          if (tf & 0x400) p += 4;
          if (tf & 0x800) p += 4;
          assert.ok(pos >= mdat.body && pos + size <= mdat.end, 'sample lies inside the following mdat');
          if (!byTrack.has(id)) byTrack.set(id, []);
          byTrack.get(id).push(buf.subarray(pos, pos + size));
          pos += size;
        }
      }
    }
  });
  return { byTrack, sequence, order, tfhdFlags };
}

// ---------------------------------------------------------------- fixtures

const VIDEO = { id: 1, handler: 'vide', timescale: 12800, delta: 512, samples: makeSamples('V', 7, 40), chunks: [3, 2, 2] };
const EXTRA_AUDIO = { id: 2, handler: 'soun', timescale: 48000, delta: 1024, samples: makeSamples('x', 4, 30), chunks: [2, 2] };
const AUDIO = {
  id: 1, handler: 'soun', timescale: 44100, delta: 1024, samples: makeSamples('A', 15, 20), chunks: [4, 4, 4, 3],
  edit: { segment: 15 * 1024, mediaTime: 0 },
};
const FRAG_VIDEO = [makeSamples('V', 3, 40), makeSamples('W', 3, 40)];
const FRAG_AUDIO = [makeSamples('A', 4, 20), makeSamples('B', 4, 20), makeSamples('C', 4, 20)];

let dir;
let files;
const exists = (file) => access(file).then(() => true, () => false);
async function put(name, data) {
  const file = join(dir, name);
  await writeFile(file, data);
  return file;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'luz-media-mux-'));
  files = {
    // video file also carries an interleaved audio track that must not be copied
    progVideo: await put('prog-video.mp4', progressiveFile({
      movieTimescale: 1000, tracks: [VIDEO, EXTRA_AUDIO], moovFirst: false, mdat: 'large', interleave: true,
    })),
    progAudio: await put('prog-audio.m4a', progressiveFile({
      movieTimescale: 44100, tracks: [AUDIO], moovFirst: true, mdat: 'to-eof', offsetType: 'co64',
    })),
    fragVideo: await put('frag-video.m4s', fragmentedFile({
      id: 1, handler: 'vide', timescale: 12800, delta: 512, fragments: FRAG_VIDEO, rich: true,
    })),
    fragAudio: await put('frag-audio.m4s', fragmentedFile({
      id: 1, handler: 'soun', timescale: 44100, delta: 1024, fragments: FRAG_AUDIO, modes: ['base', 'implicit'], extras: true,
    })),
    webm: await put('video.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01])),
    text: await put('page.html', Buffer.from('<!doctype html><title>not media</title>')),
  };
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

test('progressive inputs: one moov before one mdat, offsets rewritten, audio renumbered', async () => {
  const out = join(dir, 'prog-out.mp4');
  const result = await muxAudioVideo(files.progVideo, files.progAudio, out);
  const buf = await readFile(out);
  assert.equal(result.file, out);
  assert.equal(result.bytes, buf.length);
  assert.equal(result.fragmented, false);
  assert.deepEqual(result.video, { id: 1, codec: 'avc1', timescale: 12800, duration: 3584, seconds: 3584 / 12800 });
  assert.deepEqual(result.audio, { id: 2, codec: 'mp4a', timescale: 44100, duration: 15360, seconds: 15360 / 44100 });

  const top = boxes(buf);
  assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov', 'mdat'], 'faststart: moov precedes the single mdat');
  const [, moov, mdat] = top;
  const traks = kids(buf, moov).filter((b) => b.type === 'trak');
  assert.equal(traks.length, 2);
  const ids = traks.map((t) => buf.readUInt32BE(dig(buf, t, 'tkhd').body + 12));
  assert.deepEqual(ids, [1, 2]);
  assert.deepEqual(traks.map((t) => buf.toString('latin1', dig(buf, t, 'mdia', 'hdlr').body + 8, dig(buf, t, 'mdia', 'hdlr').body + 12)), ['vide', 'soun']);

  const mv = dig(buf, moov, 'mvhd');
  assert.equal(buf.readUInt32BE(mv.body + 12), 1000, 'movie timescale taken from the video input');
  assert.equal(buf.readUInt32BE(mv.body + 16), 348, 'mvhd duration = max(280, 348)');
  assert.ok(buf.readUInt32BE(mv.body + 96) > Math.max(...ids), 'next_track_ID above every track ID');
  assert.deepEqual(traks.map((t) => buf.readUInt32BE(dig(buf, t, 'tkhd').body + 20)), [280, 348], 'tkhd durations in movie timescale');
  assert.equal(buf.readUInt32BE(dig(buf, traks[1], 'edts', 'elst').body + 8), 348, 'elst segment rescaled 44100 -> 1000');

  const video = progressiveSamples(buf, traks[0]);
  const audio = progressiveSamples(buf, traks[1]);
  assert.deepEqual(video.samples, VIDEO.samples);
  assert.deepEqual(audio.samples, AUDIO.samples);
  assert.equal(audio.offsetType, 'stco', 'small offsets go back to stco');
  for (const [s, e] of [...video.ranges, ...audio.ranges]) assert.ok(s >= mdat.body && e <= mdat.end);
  const expected = [...VIDEO.samples, ...AUDIO.samples].reduce((n, s) => n + s.length, 0);
  assert.equal(mdat.end - mdat.body, expected, 'mdat holds exactly the two selected tracks');
  assert.ok(!buf.includes('<x:'), 'the extra audio track of the video input is not copied');
});

test('fragmented inputs: moov+mvex, fragments interleaved, IDs and data offsets rewritten', async () => {
  const out = join(dir, 'frag-out.mp4');
  const result = await muxAudioVideo(files.fragVideo, files.fragAudio, out);
  const buf = await readFile(out);
  assert.equal(result.bytes, buf.length);
  assert.equal(result.fragmented, true);
  assert.equal(result.video.duration, 6 * 512);
  assert.equal(result.audio.duration, 12 * 1024);
  assert.equal(result.audio.id, 2);

  const top = boxes(buf);
  assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov', ...Array(5).fill(['moof', 'mdat']).flat()], 'sidx/styp dropped');
  const moov = top[1];
  const traks = kids(buf, moov).filter((b) => b.type === 'trak');
  const ids = traks.map((t) => buf.readUInt32BE(dig(buf, t, 'tkhd').body + 12));
  assert.deepEqual(ids, [1, 2]);
  const mvex = dig(buf, moov, 'mvex');
  assert.deepEqual(kids(buf, mvex).filter((b) => b.type === 'trex').map((b) => buf.readUInt32BE(b.body + 4)), [1, 2]);
  const mv = dig(buf, moov, 'mvhd');
  assert.equal(buf.readUInt32BE(mv.body + 16), 279, 'mvhd duration = max(240, 278.6)');
  assert.equal(buf.readUInt32BE(dig(buf, mvex, 'mehd').body + 4), 279);
  assert.ok(buf.readUInt32BE(mv.body + 96) > 2);

  const { byTrack, sequence, order, tfhdFlags } = fragmentSamples(buf);
  assert.deepEqual(sequence, [1, 2, 3, 4, 5], 'mfhd sequence numbers strictly increasing');
  assert.deepEqual(order, [1, 2, 2, 1, 2], 'fragments interleaved by decode time');
  for (const flags of tfhdFlags) {
    assert.ok(flags & 0x020000, 'default-base-is-moof');
    assert.equal(flags & 0x01, 0, 'no absolute base_data_offset');
  }
  assert.deepEqual(byTrack.get(1), FRAG_VIDEO.flat());
  assert.deepEqual(byTrack.get(2), FRAG_AUDIO.flat());
});

test('isoBmffInfo probes tracks without reading media data', async () => {
  assert.deepEqual(await isoBmffInfo(files.progVideo), {
    isoBmff: true,
    fragmented: false,
    tracks: [
      { id: 1, handler: 'vide', codec: 'avc1', timescale: 12800 },
      { id: 2, handler: 'soun', codec: 'mp4a', timescale: 48000 },
    ],
  });
  assert.deepEqual(await isoBmffInfo(files.fragAudio), {
    isoBmff: true, fragmented: true, tracks: [{ id: 1, handler: 'soun', codec: 'mp4a', timescale: 44100 }],
  });
  assert.deepEqual(await isoBmffInfo(files.webm), { isoBmff: false, fragmented: false, tracks: [] });
  assert.deepEqual(await isoBmffInfo(files.text), { isoBmff: false, fragmented: false, tracks: [] });
});

test('non-ISO inputs are rejected with unsupported_container and leave no output', async () => {
  const out = join(dir, 'rejected.mp4');
  await assert.rejects(muxAudioVideo(files.webm, files.progAudio, out), { code: 'unsupported_container', message: /WebM\/Matroska/ });
  await assert.rejects(muxAudioVideo(files.progVideo, files.text, out), { code: 'unsupported_container' });
  assert.equal(await exists(out), false);
});

test('encrypted sample entries are rejected', async () => {
  const enc = await put('enc.m4a', progressiveFile({ movieTimescale: 1000, tracks: [{ ...AUDIO, entry: mp4a('enca') }] }));
  await assert.rejects(muxAudioVideo(files.progVideo, enc, join(dir, 'enc-out.mp4')), { code: 'unsupported_container', message: /encrypted/ });
});

test('structural problems fail with mux_failed and leave no output', async () => {
  const out = join(dir, 'failed.mp4');
  await assert.rejects(muxAudioVideo(files.progVideo, files.fragAudio, out), { code: 'mux_failed', message: /progressive video .* fragmented audio/ });
  await assert.rejects(muxAudioVideo(files.fragVideo, files.fragVideo, out), { code: 'mux_failed', message: /no 'soun' track/ });
  const whole = await readFile(files.progVideo);
  const truncated = await put('truncated.mp4', whole.subarray(0, whole.length - 40));
  await assert.rejects(muxAudioVideo(truncated, files.progAudio, out), { code: 'mux_failed' });
  await assert.rejects(muxAudioVideo(files.progVideo, files.progAudio, out, { maxBytes: 200 }), { code: 'mux_failed', message: /limit/ });
  assert.equal(await exists(out), false);
});

test('chunk offsets above 2^32 switch stco to co64 and keep parent sizes consistent', () => {
  const trakBuf = trakBox(VIDEO, 1000, [100, 200, 300], 'stco');
  const [trak] = _internal.parseTree(trakBuf);
  const stbl = ['mdia', 'minf', 'stbl'].reduce((node, type) => node.children.find((c) => c.type === type), trak);
  const big = [2 ** 32 + 5, 2 ** 32 + 1000, 2 ** 33 + 7];
  _internal.rewriteChunkOffsets(stbl, big);
  const out = _internal.serialize(trak);
  assert.equal(out.length, trakBuf.length + 3 * 4, 'three entries grew from 4 to 8 bytes');
  const [root] = boxes(out);
  assert.equal(root.end, out.length);
  const types = kids(out, dig(out, root, 'mdia', 'minf', 'stbl')).map((b) => b.type);
  assert.ok(types.includes('co64') && !types.includes('stco'));
  const co64 = dig(out, root, 'mdia', 'minf', 'stbl', 'co64');
  assert.deepEqual([0, 1, 2].map((i) => Number(out.readBigUInt64BE(co64.body + 8 + i * 8))), big);

  _internal.rewriteChunkOffsets(stbl, [1, 2, 3]);
  const back = _internal.serialize(trak);
  assert.equal(back.length, trakBuf.length);
  assert.ok(back.includes('stco') && !back.includes('co64'));
});
