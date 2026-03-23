import fs from 'fs';

export class FileIngest {
  private filePath: string;

  constructor(filePath: string) {
    if (!fs.existsSync(filePath)) {
      throw new Error('File not found');
    }
    this.filePath = filePath;
  }

  getInputPath(): string {
    return this.filePath;
  }
}
