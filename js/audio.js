// Recordings from the tablet: IMA ADPCM blocks (firmware adpcm.h) -> 16-bit WAV.
export const ADPCM_SAMPLES = 2048, ADPCM_BLOCK = 4 + ADPCM_SAMPLES / 2;

const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
  1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

// blocks: Uint8Array of whole blocks; samples: how many to keep (the last block is padded).
export function decodeAdpcm(blocks, samples) {
  const nb = Math.floor(blocks.length / ADPCM_BLOCK);
  const out = new Int16Array(Math.min(samples, nb * ADPCM_SAMPLES));
  for (let b = 0; b < nb; b++) {
    const o = b * ADPCM_BLOCK;
    let pred = (blocks[o] | (blocks[o + 1] << 8)) << 16 >> 16, index = Math.min(88, blocks[o + 2]);
    for (let i = 0; i < ADPCM_SAMPLES; i++) {
      const at = b * ADPCM_SAMPLES + i;
      const byte = blocks[o + 4 + (i >> 1)];
      const code = (i & 1) ? byte >> 4 : byte & 15;
      const step = STEP[index];
      let delta = step >> 3;
      if (code & 4) delta += step;
      if (code & 2) delta += step >> 1;
      if (code & 1) delta += step >> 2;
      pred += (code & 8) ? -delta : delta;
      if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
      index += INDEX[code];
      if (index < 0) index = 0; else if (index > 88) index = 88;
      if (at < out.length) out[at] = pred;
    }
  }
  return out;
}

export function wavBytes(pcm, rate) {
  const n = pcm.length * 2, buf = new ArrayBuffer(44 + n), dv = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

export const fmtDuration = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
