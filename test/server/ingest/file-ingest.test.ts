import { describe, it, expect } from 'vitest';
import path from 'path';
import { FileIngest } from '../../../src/server/ingest/file-ingest.js';

describe('FileIngest', () => {
  it('throws "File not found" for a nonexistent file', () => {
    expect(() => new FileIngest('/nonexistent/path/to/file.mp4')).toThrow('File not found');
  });

  it('returns the file path for an existing file', () => {
    const pkgPath = path.resolve('package.json');
    const ingest = new FileIngest(pkgPath);
    expect(ingest.getInputPath()).toBe(pkgPath);
  });
});
