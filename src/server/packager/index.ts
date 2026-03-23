import { EventEmitter } from 'events';
import { buildTSPacket } from './ts-packet.js';
import { buildPESPacket } from './pes-packet.js';
import { buildPAT, buildPMT } from './psi.js';
import { Segmenter } from './segmenter.js';
import {
  VIDEO_PID, AUDIO_PID, PAT_PID, PMT_PID,
  TS_PACKET_SIZE, SegmentInfo, QualityLevel,
} from '../../shared/types.js';

// Re-export submodules
export { Segmenter } from './segmenter.js';
export { buildTSPacket } from './ts-packet.js';
export { buildPESPacket } from './pes-packet.js';
export { buildPAT, buildPMT } from './psi.js';

/**
 * Wrap a PES buffer into one or more 188-byte TS packets.
 *
 * The first packet has payloadUnitStart=true and optionally carries a PCR.
 * Subsequent packets carry successive slices of the PES payload.
 *
 * Returns the array of 188-byte TS packet Buffers and the updated continuity
 * counter value (caller stores this for the next call).
 */
function pesToTSPackets(
  pes: Buffer,
  pid: number,
  cc: number,
  pcr?: number,
): { packets: Buffer[]; nextCC: number } {
  const packets: Buffer[] = [];
  const MAX_PAYLOAD = TS_PACKET_SIZE - 4; // 184 bytes without AF, less with AF

  let offset = 0;
  let first = true;

  while (offset < pes.length || first) {
    const isFirst = first;
    first = false;

    // For the first packet we may have a PCR in the adaptation field, which
    // costs 8 bytes (1 afLen + 1 flags + 6 PCR).
    const hasPCR = isFirst && pcr !== undefined;
    const afOverhead = hasPCR ? 8 : 0; // afLen(1) + flags(1) + PCR(6)
    const maxPayloadThisPacket = MAX_PAYLOAD - afOverhead;

    const slice = pes.subarray(offset, offset + maxPayloadThisPacket);
    offset += slice.length;

    const pkt = buildTSPacket({
      pid,
      payload: slice,
      payloadUnitStart: isFirst,
      continuityCounter: cc & 0x0F,
      pcr: hasPCR ? pcr : undefined,
    });

    packets.push(pkt);
    cc = (cc + 1) & 0x0F;
  }

  return { packets, nextCC: cc };
}

export class TSPackager extends EventEmitter {
  private quality: QualityLevel;
  private segmenter: Segmenter;

  // Buffered TS packets for the segment currently being assembled
  private segmentPackets: Buffer[] = [];

  // Continuity counters (wrap at 16)
  private ccPAT: number = 0;
  private ccPMT: number = 0;
  private ccVideo: number = 0;
  private ccAudio: number = 0;

  // Index of the segment that is currently being filled (starts at -1 = none)
  private currentSegmentIndex: number = -1;

  // PTS at which the current segment started (for duration calculation on flush)
  private segmentStartPts: number = 0;

  // Last video PTS seen (used for flush duration estimate)
  private lastVideoPts: number = 0;

  constructor(quality: QualityLevel) {
    super();
    this.quality = quality;
    this.segmenter = new Segmenter();
  }

  /**
   * Push raw H.264 Annex B data with PTS (and optional DTS).
   *
   * Internally asks the Segmenter whether this frame starts a new segment. If
   * so, the previous segment is flushed and PAT + PMT are written at the start
   * of the new one.
   */
  pushVideo(data: Buffer, pts: number, dts?: number): void {
    this.lastVideoPts = pts;

    const result = this.segmenter.pushVideoData(data, pts);

    if (result.isNewSegment) {
      // --- Flush the segment that just completed (if any) ---
      if (this.currentSegmentIndex >= 0 && this.segmentPackets.length > 0) {
        const duration = result.completedSegmentDuration ?? 0;
        this._emitSegment(this.currentSegmentIndex, duration);
      }

      // --- Start a new segment ---
      this.currentSegmentIndex = this.segmenter.currentSegmentIndex;
      this.segmentStartPts = pts;
      this.segmentPackets = [];

      // Write PAT and PMT at the head of every new segment
      this._writePAT();
      this._writePMT();
    }

    // Only packetize when we have an active segment (i.e. first IDR seen)
    if (this.currentSegmentIndex < 0) return;

    // Build PES and packetize into TS
    const pes = buildPESPacket({
      streamId: 0xE0,
      payload: data,
      pts,
      dts,
    });

    const { packets, nextCC } = pesToTSPackets(pes, VIDEO_PID, this.ccVideo, pts);
    this.ccVideo = nextCC;
    for (const pkt of packets) this.segmentPackets.push(pkt);
  }

  /**
   * Push raw AAC ADTS data with PTS.
   */
  pushAudio(data: Buffer, pts: number): void {
    // Only packetize when we have an active segment
    if (this.currentSegmentIndex < 0) return;

    const pes = buildPESPacket({
      streamId: 0xC0,
      payload: data,
      pts,
    });

    const { packets, nextCC } = pesToTSPackets(pes, AUDIO_PID, this.ccAudio);
    this.ccAudio = nextCC;
    for (const pkt of packets) this.segmentPackets.push(pkt);
  }

  /**
   * Flush the final (possibly incomplete) segment.
   */
  flush(): void {
    if (this.currentSegmentIndex < 0 || this.segmentPackets.length === 0) return;

    const duration = (this.lastVideoPts - this.segmentStartPts) / 90_000;
    this._emitSegment(this.currentSegmentIndex, duration);

    // Reset state
    this.segmentPackets = [];
    this.currentSegmentIndex = -1;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _writePAT(): void {
    const patSection = buildPAT(PMT_PID);
    const pkt = buildTSPacket({
      pid: PAT_PID,
      payload: patSection,
      payloadUnitStart: true,
      continuityCounter: this.ccPAT & 0x0F,
    });
    this.ccPAT = (this.ccPAT + 1) & 0x0F;
    this.segmentPackets.push(pkt);
  }

  private _writePMT(): void {
    const pmtSection = buildPMT(VIDEO_PID, AUDIO_PID);
    const pkt = buildTSPacket({
      pid: PMT_PID,
      payload: pmtSection,
      payloadUnitStart: true,
      continuityCounter: this.ccPMT & 0x0F,
    });
    this.ccPMT = (this.ccPMT + 1) & 0x0F;
    this.segmentPackets.push(pkt);
  }

  private _emitSegment(index: number, duration: number): void {
    const data = Buffer.concat(this.segmentPackets);
    const info: SegmentInfo = {
      index,
      duration,
      filename: `seg-${index}.ts`,
      quality: this.quality,
      byteSize: data.length,
    };
    this.emit('segment', info, data);
  }
}
