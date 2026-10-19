import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';

/**
 * A minimal streaming ZIP writer (deflate, UTF-8 names, data descriptors).
 *
 * Each entry is compressed as it is produced, so an export of any size never
 * has to be held in memory. Entries over 4 GB (ZIP64) are refused with a
 * clear error rather than written as a corrupt archive.
 */

export interface ByteSink {
  write(chunk: Buffer): Promise<unknown>;
}

interface Entry {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

const LIMIT_32 = 0xffffffff;

export class ZipTooLargeError extends Error {
  constructor() {
    super('The export is larger than a ZIP file can hold (4 GB per file).');
    this.name = 'ZipTooLargeError';
  }
}

export class ZipWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;
  private finished = false;

  constructor(private readonly sink: ByteSink) {}

  /** Add a file whose content is produced by `chunks`. Entries are written one after another. */
  async addFile(name: string, chunks: AsyncIterable<string | Buffer> | Iterable<string | Buffer>, modified: Date): Promise<void> {
    if (this.finished) throw new Error('ZipWriter: archive already finished');
    const nameBytes = Buffer.from(name, 'utf8');
    const { dosTime, dosDate } = toDos(modified);
    const offset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0808, 6); // bit 3: data descriptor; bit 11: UTF-8 name
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    // crc / sizes are 0 here and follow in the data descriptor
    header.writeUInt16LE(nameBytes.length, 26);
    await this.emit(header);
    await this.emit(nameBytes);

    let crc = 0xffffffff;
    let size = 0;
    let compressedSize = 0;

    async function* measured() {
      for await (const chunk of chunks) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        if (buf.length === 0) continue;
        crc = crc32Update(crc, buf);
        size += buf.length;
        if (size > LIMIT_32) throw new ZipTooLargeError();
        yield buf;
      }
    }

    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        compressedSize += chunk.length;
        if (compressedSize > LIMIT_32) {
          callback(new ZipTooLargeError());
          return;
        }
        this.emit(chunk).then(() => callback(), callback);
      },
    });
    await pipeline(Readable.from(measured()), createDeflateRaw({ level: 6 }), sink);

    const finalCrc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(finalCrc, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.emit(descriptor);

    this.entries.push({ name: nameBytes, crc: finalCrc, compressedSize, size, offset, dosTime, dosDate });
  }

  /** Write the central directory. The sink is not closed. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.entries.length > 0xffff) throw new ZipTooLargeError();
    const start = this.offset;
    for (const e of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4); // made by
      record.writeUInt16LE(20, 6); // needed
      record.writeUInt16LE(0x0808, 8);
      record.writeUInt16LE(8, 10);
      record.writeUInt16LE(e.dosTime, 12);
      record.writeUInt16LE(e.dosDate, 14);
      record.writeUInt32LE(e.crc, 16);
      record.writeUInt32LE(e.compressedSize, 20);
      record.writeUInt32LE(e.size, 24);
      record.writeUInt16LE(e.name.length, 28);
      record.writeUInt32LE(e.offset, 42);
      await this.emit(record);
      await this.emit(e.name);
    }
    const size = this.offset - start;
    if (this.offset > LIMIT_32) throw new ZipTooLargeError();
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    await this.emit(end);
  }

  /** Bytes written so far. */
  get bytesWritten(): number {
    return this.offset;
  }

  private async emit(chunk: Buffer): Promise<void> {
    await this.sink.write(chunk);
    this.offset += chunk.length;
  }
}

function toDos(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, buf: Buffer): number {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

/** CRC-32 of a buffer (exported for tests). */
export function crc32(buf: Buffer): number {
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}
