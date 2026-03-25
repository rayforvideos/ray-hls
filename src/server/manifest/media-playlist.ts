const LIVE_WINDOW_SIZE = 5;

interface SegmentEntry {
  index: number;
  duration: number;
  filename: string;
}

export class MediaPlaylist {
  private readonly mode: 'vod' | 'live';
  private segments: SegmentEntry[] = [];
  private finalized = false;

  constructor(mode: 'vod' | 'live') {
    this.mode = mode;
  }

  addSegment(entry: { index: number; duration: number; filename: string }): void {
    this.segments.push({ ...entry });
  }

  finalize(): void {
    this.finalized = true;
  }

  generate(): string {
    const visible = this.visibleSegments();
    const maxDuration = visible.length > 0
      ? Math.max(...visible.map(s => s.duration))
      : 0;
    const targetDuration = Math.ceil(maxDuration);
    const mediaSequence = visible.length > 0 ? visible[0].index : 0;

    const lines: string[] = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${targetDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
      '',
    ];

    for (const seg of visible) {
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      lines.push(seg.filename);
    }

    // 확정(finalize) 상태이면 종료 태그 추가 (VOD/live 동일)
    if (this.finalized) {
      lines.push('#EXT-X-ENDLIST');
    }

    return lines.join('\n');
  }

  private visibleSegments(): SegmentEntry[] {
    if (this.mode === 'vod') {
      return this.segments;
    }
    // 라이브: 마지막 LIVE_WINDOW_SIZE개 세그먼트의 슬라이딩 윈도우
    const start = Math.max(0, this.segments.length - LIVE_WINDOW_SIZE);
    return this.segments.slice(start);
  }
}
