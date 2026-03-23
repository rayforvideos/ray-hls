/**
 * Generate fMP4 media segments (moof + mdat) for MSE.
 */

import { DemuxedSample } from '../demuxer/ts-demuxer.js';
import { box, fullBox, uint32, concat } from './mp4-box.js';

/**
 * Build a trun box for the given samples.
 * Flags 0x000301: data-offset-present + sample-duration-present + sample-size-present.
 */
function trun(samples: DemuxedSample[]): Uint8Array {
  const flags = 0x000301;
  const sampleCount = samples.length;

  // 4 (sample_count) + 4 (data_offset) + sampleCount * 8 (duration + size)
  const data = new Uint8Array(8 + sampleCount * 8);
  const view = new DataView(data.buffer);
  view.setUint32(0, sampleCount, false);
  // data_offset placeholder = 0, will need to be patched by caller if needed
  view.setUint32(4, 0, false);

  for (let i = 0; i < sampleCount; i++) {
    let duration: number;
    if (i < sampleCount - 1) {
      const currentPts = samples[i].dts ?? samples[i].pts;
      const nextPts = samples[i + 1].dts ?? samples[i + 1].pts;
      duration = nextPts - currentPts;
    } else if (sampleCount > 1) {
      // Last sample: use previous sample's duration
      const prevPts = samples[sampleCount - 2].dts ?? samples[sampleCount - 2].pts;
      const curPts = samples[sampleCount - 1].dts ?? samples[sampleCount - 1].pts;
      duration = curPts - prevPts;
    } else {
      // Single sample: default duration
      duration = 1024; // reasonable default for audio; for video ~3000 at 90kHz
    }
    if (duration < 0) duration = 0;

    const offset = 8 + i * 8;
    view.setUint32(offset, duration, false);
    view.setUint32(offset + 4, samples[i].data.length, false);
  }

  return fullBox('trun', 0, flags, data);
}

function traf(trackId: number, baseDecodeTime: number, samples: DemuxedSample[]): Uint8Array {
  // tfhd flags: 0x020000 = default-base-is-moof
  const tfhdBox = fullBox('tfhd', 0, 0x020000, uint32(trackId));
  const tfdtBox = fullBox('tfdt', 0, 0, uint32(baseDecodeTime));
  const trunBox = trun(samples);
  return box('traf', tfhdBox, tfdtBox, trunBox);
}

export function generateMediaSegment(
  sequenceNumber: number,
  videoSamples: DemuxedSample[],
  audioSamples: DemuxedSample[],
  videoBaseDecodeTime: number,
  audioBaseDecodeTime: number,
): Uint8Array {
  const mfhdBox = fullBox('mfhd', 0, 0, uint32(sequenceNumber));

  const trafs: Uint8Array[] = [];
  if (videoSamples.length > 0) {
    trafs.push(traf(1, videoBaseDecodeTime, videoSamples));
  }
  if (audioSamples.length > 0) {
    trafs.push(traf(2, audioBaseDecodeTime, audioSamples));
  }

  const moofBox = box('moof', mfhdBox, ...trafs);

  // mdat: concatenated sample data (all video then all audio)
  const mdatPayloads: Uint8Array[] = [];
  for (const s of videoSamples) {
    mdatPayloads.push(s.data);
  }
  for (const s of audioSamples) {
    mdatPayloads.push(s.data);
  }
  const mdatBox = box('mdat', ...mdatPayloads);

  return concat(moofBox, mdatBox);
}
