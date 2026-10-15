'use strict';
// BLE advertising decode helpers, shared by both scanner sources:
//  - parseBlePdu: a de-whitened, CRC-valid advertising PDU -> address, address type, name.
//  - bleWhiten / bleCrc24 + bleDecodeIq: host-side decode of a raw I/Q capture, extending the
//    BLE front-end in triggers.js (rxTrigger mode 'ble'), for the "decode from my own I/Q" source.
// The on-device GFSK catcher already de-whitens and checks CRC-24; it only needs parseBlePdu.

const BLE_PDU_TYPES = ['ADV_IND', 'ADV_DIRECT_IND', 'ADV_NONCONN_IND', 'SCAN_REQ',
 'SCAN_RSP', 'CONNECT_IND', 'ADV_SCAN_IND', 'ADV_EXT_IND'];
// Adv PDU types whose payload starts with a 6-byte advertiser address.
const BLE_HAS_ADVA = new Set([0, 1, 2, 4, 6]);

function bleMac(bytes6) {
 return Array.from(bytes6).reverse().map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

// A de-whitened PDU (2-byte header + payload). CRC is handled by the caller.
function parseBlePdu(bytes) {
 if (!bytes || bytes.length < 2) return null;
 const b0 = bytes[0], type = b0 & 0x0f, txAdd = (b0 >> 6) & 1, len = bytes[1];
 const out = { pduType: type, pduName: BLE_PDU_TYPES[type] || ('type ' + type), txAdd, addrType: null, address: null, name: '', ads: [] };
 if (bytes.length >= 8 && BLE_HAS_ADVA.has(type)) {
  const a = bytes.subarray(2, 8);
  out.address = bleMac(a);
  if (!txAdd) out.addrType = 'public';
  else { const msb = a[5] >> 6; out.addrType = msb === 0b11 ? 'random-static' : msb === 0b01 ? 'rpa' : msb === 0b00 ? 'nrpa' : 'random'; }
  // AD structures in AdvData, bounded by the PDU length field.
  let k = 8; const end = Math.min(bytes.length, 2 + len);
  while (k + 1 < end) {
   const l = bytes[k]; if (!l || k + 1 + l > end) break;
   const ty = bytes[k + 1], val = bytes.subarray(k + 2, k + 1 + l);
   out.ads.push({ type: ty, data: val });
   if (ty === 0x09 || ty === 0x08) { try { out.name = new TextDecoder().decode(val); } catch (e) { out.name = ''; } }
   k += 1 + l;
  }
 }
 return out;
}

// 7-bit data-whitening LFSR (x^7 + x^4 + 1): position 0 = 1, positions 1..6 = channel bits 5..0;
// output is position 6, tap feeds position 4. Bits are processed LSB-first (BLE transmit order).
// Involutive, so the same function whitens and de-whitens.
function bleWhiten(data, channel) {
 const p = [1, (channel >> 5) & 1, (channel >> 4) & 1, (channel >> 3) & 1, (channel >> 2) & 1, (channel >> 1) & 1, channel & 1];
 const out = new Uint8Array(data.length);
 for (let i = 0; i < data.length; i++) {
  let b = data[i];
  for (let j = 0; j < 8; j++) {
   const o = p[6];
   b ^= (o << j);
   p[6] = p[5]; p[5] = p[4]; p[4] = p[3] ^ o; p[3] = p[2]; p[2] = p[1]; p[1] = p[0]; p[0] = o;
  }
  out[i] = b;
 }
 return out;
}

// BLE CRC-24 (poly x^24+x^10+x^9+x^6+x^4+x^3+x+1, reversed mask 0xDA6000), LSB-first, over the
// PDU bytes. The advertising CRCInit is 0x555555; in this reflected (LSB-first) form it is loaded
// bit-reversed as 0xAAAAAA (verified against real on-device packets). Returned LSB-first.
function bleCrc24(data, crcInit = 0xAAAAAA) {
 let state = crcInit & 0xffffff;
 for (let i = 0; i < data.length; i++) {
  let cur = data[i];
  for (let j = 0; j < 8; j++) {
   const bit = (state ^ cur) & 1;
   cur >>= 1; state >>= 1;
   if (bit) state ^= 0xDA6000;
  }
 }
 return state & 0xffffff;
}

// Decode one BLE advertising packet from a raw I/Q capture at `channel` (37/38/39). Reuses the
// discriminator + CFO + access-address correlation of rxTrigger(mode:'ble') to find and time the
// packet, then slices the PDU bits, de-whitens, checks CRC-24 and parses. Returns the parsed
// device (crcOk true), {crcOk:false} on a failed CRC, or null if no packet was found.
function bleDecodeIq(iq, rate, channel) {
 const trig = rxTrigger(iq, rate, { mode: 'ble', threshold: -50 });
 if (!trig.matched) return null;
 const n = iq.length / 2, sps = Math.round(rate / 1e6), cfo = trig.cfo_hz || 0;
 // Same discriminator as rxTrigger: DC-remove, accumulate instantaneous frequency into a phase
 // integral, then each symbol's bit is the mean frequency over the symbol vs the fitted CFO.
 let mi = 0, mq = 0; for (let j = 0; j < n; j++) { mi += iq[2 * j]; mq += iq[2 * j + 1]; } mi /= n; mq /= n;
 const re = new Float64Array(n), im = new Float64Array(n);
 for (let j = 0; j < n; j++) { re[j] = iq[2 * j] - mi; im[j] = iq[2 * j + 1] - mq; }
 const phase = new Float64Array(n + 1);
 for (let j = 1; j < n; j++) phase[j + 1] = phase[j] + Math.atan2(im[j] * re[j - 1] - re[j] * im[j - 1], re[j] * re[j - 1] + im[j] * im[j - 1]) * rate / (2 * Math.PI);
 // Symbol index 0 = first preamble bit; the PDU (whitened) begins at symbol 40 (after the 8-bit
 // preamble and 32-bit access address).
 const symBit = S => { const j = trig.sample + S * sps; if (j + sps >= n) return null; return (phase[j + sps] - phase[j]) / sps >= cfo ? 1 : 0; };
 const MAX = 64, raw = new Uint8Array(MAX); let got = 0;
 outer: for (let bi = 0; bi < MAX; bi++) { let b = 0; for (let bit = 0; bit < 8; bit++) { const v = symBit(40 + bi * 8 + bit); if (v === null) break outer; b |= v << bit; } raw[bi] = b; got = bi + 1; }
 if (got < 5) return null;
 const dew = bleWhiten(raw.subarray(0, got), channel); // de-whiten (involutive)
 const len = dew[1], total = 2 + len + 3;
 if (total < 5 || total > got) return { crcOk: false };
 const pdu = dew.subarray(0, 2 + len);
 const crcRx = dew[2 + len] | (dew[3 + len] << 8) | (dew[4 + len] << 16);
 if (bleCrc24(pdu) !== (crcRx & 0xffffff)) return { crcOk: false };
 const parsed = parseBlePdu(pdu); if (parsed) { parsed.crcOk = true; parsed.rssi_dbfs = trig.peak_dbfs; }
 return parsed;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parseBlePdu, bleWhiten, bleCrc24, bleDecodeIq, bleMac, BLE_PDU_TYPES };
