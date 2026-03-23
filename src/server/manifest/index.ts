import { QualityLevel } from '../../shared/types.js';
import { generateMasterPlaylist } from './master-playlist.js';
import { MediaPlaylist } from './media-playlist.js';

export { generateMasterPlaylist } from './master-playlist.js';
export { MediaPlaylist } from './media-playlist.js';

export class ManifestGenerator {
  private readonly levels: QualityLevel[];
  private readonly mode: 'vod' | 'live';
  private readonly playlists: Map<string, MediaPlaylist>;

  constructor(levels: QualityLevel[], mode: 'vod' | 'live') {
    this.levels = levels;
    this.mode = mode;
    this.playlists = new Map();
    for (const level of levels) {
      this.playlists.set(level.name, new MediaPlaylist(mode));
    }
  }

  getMasterPlaylist(): string {
    return generateMasterPlaylist(this.levels);
  }

  addSegment(
    qualityName: string,
    segment: { index: number; duration: number; filename: string },
  ): void {
    const playlist = this.playlists.get(qualityName);
    if (playlist) {
      playlist.addSegment(segment);
    }
  }

  getMediaPlaylist(qualityName: string): string | null {
    const playlist = this.playlists.get(qualityName);
    return playlist ? playlist.generate() : null;
  }

  finalize(): void {
    for (const playlist of this.playlists.values()) {
      playlist.finalize();
    }
  }
}
