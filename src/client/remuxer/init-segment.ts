/**
 * Generate fMP4 initialization segment (ftyp + moov) for MSE.
 */

import { box, fullBox, uint32, uint16, uint8, concat } from './mp4-box.js';

export interface InitSegmentOptions {
  width: number;
  height: number;
  sps: Uint8Array;
  pps: Uint8Array;
  audioSampleRate: number;
  audioChannels: number;
  trackType?: 'video' | 'audio' | 'both';
}

const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
];

/** Identity matrix for tkhd/mvhd (36 bytes). */
function identityMatrix(): Uint8Array {
  const m = new Uint8Array(36);
  const view = new DataView(m.buffer);
  view.setUint32(0, 0x00010000, false);  // a = 1.0
  view.setUint32(16, 0x00010000, false); // d = 1.0
  view.setUint32(32, 0x40000000, false); // w = 1.0
  return m;
}

function ftyp(): Uint8Array {
  // ftyp: major_brand=isom, minor_version=512, compatible_brands=[isom, iso2, avc1, mp41]
  return box(
    'ftyp',
    uint32(0x69736f6d), // isom
    uint32(0x00000200), // minor version 512
    uint32(0x69736f6d), // isom
    uint32(0x69736f32), // iso2
    uint32(0x61766331), // avc1
    uint32(0x6d703431), // mp41
  );
}

function mvhd(): Uint8Array {
  // 96 bytes of data
  const data = new Uint8Array(96);
  const view = new DataView(data.buffer);
  // creation_time = 0 (offset 0)
  // modification_time = 0 (offset 4)
  view.setUint32(8, 90000, false);       // timescale
  // duration = 0 (offset 12)
  view.setUint32(16, 0x00010000, false);  // rate 1.0
  view.setUint16(20, 0x0100, false);      // volume 1.0
  // reserved 10 bytes (offset 22)
  // matrix at offset 32 (36 bytes)
  const matrix = identityMatrix();
  data.set(matrix, 32);
  // pre_defined 24 bytes (offset 68) = 0
  view.setUint32(92, 3, false); // next_track_ID
  return fullBox('mvhd', 0, 0, data);
}

function tkhd(trackId: number, isAudio: boolean, width: number, height: number): Uint8Array {
  const data = new Uint8Array(80);
  const view = new DataView(data.buffer);
  // creation_time = 0 (offset 0)
  // modification_time = 0 (offset 4)
  view.setUint32(8, trackId, false);    // track_ID
  // reserved (offset 12)
  // duration = 0 (offset 16)
  // reserved 8 bytes (offset 20)
  // layer = 0 (offset 28)
  view.setUint16(30, isAudio ? 1 : 0, false); // alternate_group
  view.setUint16(32, isAudio ? 0x0100 : 0, false); // volume
  // reserved 2 bytes (offset 34)
  const matrix = identityMatrix();
  data.set(matrix, 36);
  if (!isAudio) {
    view.setUint32(72, width << 16, false);   // width fixed-point
    view.setUint32(76, height << 16, false);  // height fixed-point
  }
  return fullBox('tkhd', 0, 0x000003, data);
}

function mdhd(timescale: number): Uint8Array {
  const data = new Uint8Array(20);
  const view = new DataView(data.buffer);
  // creation_time = 0, modification_time = 0
  view.setUint32(8, timescale, false);
  // duration = 0
  view.setUint16(16, 0x55c4, false); // language 'und'
  // pre_defined = 0
  return fullBox('mdhd', 0, 0, data);
}

function hdlr(handlerType: string, name: string): Uint8Array {
  const nameBytes = new Uint8Array(name.length + 1); // null-terminated
  for (let i = 0; i < name.length; i++) {
    nameBytes[i] = name.charCodeAt(i);
  }
  return fullBox(
    'hdlr',
    0,
    0,
    uint32(0),             // pre_defined
    uint32(                // handler_type
      (handlerType.charCodeAt(0) << 24) |
      (handlerType.charCodeAt(1) << 16) |
      (handlerType.charCodeAt(2) << 8) |
      handlerType.charCodeAt(3),
    ),
    new Uint8Array(12),    // reserved
    nameBytes,
  );
}

function vmhd(): Uint8Array {
  // graphicsmode(2) + opcolor(6)
  return fullBox('vmhd', 0, 1, new Uint8Array(8));
}

function smhd(): Uint8Array {
  // balance(2) + reserved(2)
  return fullBox('smhd', 0, 0, new Uint8Array(4));
}

function dinf(): Uint8Array {
  const dref = fullBox(
    'dref',
    0,
    0,
    uint32(1), // entry_count
    fullBox('url ', 0, 1), // self-contained flag
  );
  return box('dinf', dref);
}

function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const data = concat(
    uint8(1),              // configurationVersion
    uint8(sps[1]),         // profile
    uint8(sps[2]),         // compatibility
    uint8(sps[3]),         // level
    uint8(0xff),           // lengthSizeMinusOne = 3 (NALU length = 4)
    uint8(0xe1),           // numSPS = 1
    uint16(sps.length),
    sps,
    uint8(1),              // numPPS
    uint16(pps.length),
    pps,
  );
  return box('avcC', data);
}

function avc1(width: number, height: number, sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const data = concat(
    new Uint8Array(6),       // reserved
    uint16(1),               // data_reference_index
    new Uint8Array(16),      // pre_defined + reserved
    uint16(width),
    uint16(height),
    uint32(0x00480000),      // horizresolution
    uint32(0x00480000),      // vertresolution
    uint32(0),               // reserved
    uint16(1),               // frame_count
    new Uint8Array(32),      // compressorname
    uint16(0x0018),          // depth
    uint16(0xffff),          // pre_defined = -1
    avcC(sps, pps),
  );
  return box('avc1', data);
}

function esds(sampleRate: number, channels: number): Uint8Array {
  const sampleRateIndex = SAMPLE_RATES.indexOf(sampleRate);
  const idx = sampleRateIndex >= 0 ? sampleRateIndex : 4; // default 44100

  // AudioSpecificConfig (2 bytes): AAC-LC objectType=2
  const objectType = 2;
  const asc0 = (objectType << 3) | (idx >> 1);
  const asc1 = ((idx & 1) << 7) | (channels << 3);

  // Build ESDS payload using descriptor tags
  const decoderSpecificInfo = new Uint8Array([
    0x05, // DecoderSpecificInfo tag
    2,    // length
    asc0,
    asc1,
  ]);

  const decoderConfigDescriptor = concat(
    new Uint8Array([
      0x04, // DecoderConfigDescriptor tag
      13 + decoderSpecificInfo.length, // length
      0x40, // objectTypeIndication = AAC
      0x15, // streamType = audio (0x05 << 2 | 0x01)
      0x00, 0x00, 0x00, // bufferSizeDB
      0x00, 0x00, 0x00, 0x00, // maxBitrate
      0x00, 0x00, 0x00, 0x00, // avgBitrate
    ]),
    decoderSpecificInfo,
  );

  const slConfigDescriptor = new Uint8Array([
    0x06, // SLConfigDescriptor tag
    1,    // length
    0x02, // predefined
  ]);

  const esDescriptor = concat(
    new Uint8Array([
      0x03, // ES_Descriptor tag
      3 + decoderConfigDescriptor.length + slConfigDescriptor.length, // length
      0x00, 0x02, // ES_ID = 2
      0x00,       // flags
    ]),
    decoderConfigDescriptor,
    slConfigDescriptor,
  );

  return fullBox('esds', 0, 0, esDescriptor);
}

function mp4a(sampleRate: number, channels: number): Uint8Array {
  const data = concat(
    new Uint8Array(6),    // reserved
    uint16(1),            // data_reference_index
    new Uint8Array(8),    // reserved
    uint16(channels),     // channelcount
    uint16(16),           // samplesize
    uint32(0),            // reserved
    uint16(sampleRate),   // samplerate integer part
    uint16(0),            // samplerate fractional part
    esds(sampleRate, channels),
  );
  return box('mp4a', data);
}

function stbl(sampleEntry: Uint8Array): Uint8Array {
  const stsd = fullBox('stsd', 0, 0, uint32(1), sampleEntry);
  const stts = fullBox('stts', 0, 0, uint32(0)); // 0 entries
  const stsc = fullBox('stsc', 0, 0, uint32(0));
  const stsz = fullBox('stsz', 0, 0, uint32(0), uint32(0)); // sample_size=0, count=0
  const stco = fullBox('stco', 0, 0, uint32(0));
  return box('stbl', stsd, stts, stsc, stsz, stco);
}

function videoTrak(opts: InitSegmentOptions): Uint8Array {
  const { width, height, sps, pps } = opts;
  const tkhdBox = tkhd(1, false, width, height);
  const mdhdBox = mdhd(90000);
  const hdlrBox = hdlr('vide', 'VideoHandler');
  const vmhdBox = vmhd();
  const dinfBox = dinf();
  const stblBox = stbl(avc1(width, height, sps, pps));
  const minfBox = box('minf', vmhdBox, dinfBox, stblBox);
  const mdiaBox = box('mdia', mdhdBox, hdlrBox, minfBox);
  return box('trak', tkhdBox, mdiaBox);
}

function audioTrak(opts: InitSegmentOptions): Uint8Array {
  const { audioSampleRate, audioChannels } = opts;
  const tkhdBox = tkhd(2, true, 0, 0);
  const mdhdBox = mdhd(audioSampleRate);
  const hdlrBox = hdlr('soun', 'SoundHandler');
  const smhdBox = smhd();
  const dinfBox = dinf();
  const stblBox = stbl(mp4a(audioSampleRate, audioChannels));
  const minfBox = box('minf', smhdBox, dinfBox, stblBox);
  const mdiaBox = box('mdia', mdhdBox, hdlrBox, minfBox);
  return box('trak', tkhdBox, mdiaBox);
}

function trex(trackId: number): Uint8Array {
  return fullBox(
    'trex',
    0,
    0,
    uint32(trackId),
    uint32(1), // default_sample_description_index
    uint32(0), // default_sample_duration
    uint32(0), // default_sample_size
    uint32(0), // default_sample_flags
  );
}

export function generateInitSegment(opts: InitSegmentOptions): Uint8Array {
  const trackType = opts.trackType ?? 'both';

  const ftypBox = ftyp();

  const traks: Uint8Array[] = [];
  const trexes: Uint8Array[] = [];

  if (trackType === 'video' || trackType === 'both') {
    traks.push(videoTrak(opts));
    trexes.push(trex(1));
  }
  if (trackType === 'audio' || trackType === 'both') {
    traks.push(audioTrak(opts));
    trexes.push(trex(2));
  }

  const mvexBox = box('mvex', ...trexes);
  const moovBox = box('moov', mvhd(), ...traks, mvexBox);

  return concat(ftypBox, moovBox);
}
