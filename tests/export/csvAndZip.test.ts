import { describe, it, expect } from 'vitest';
import { csvCell, csvRow } from '../../src/export/csv';
import { ZipWriter, crc32 } from '../../src/export/ZipWriter';
import { parseCsv, unzip } from './helpers';

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('cr\rlf')).toBe('"cr\rlf"');
  });

  it('keeps Unicode as it is', () => {
    expect(csvCell('Résumé — 日本語 🚀')).toBe('Résumé — 日本語 🚀');
  });

  it('neutralises spreadsheet formulas in text', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('+1+2')).toBe("'+1+2");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
  });

  it('writes numbers and booleans as values, never prefixed', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(3.5)).toBe('3.5');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('round-trips through a CSV parser', () => {
    const values = ['plain', 'a,b', 'q "x"', 'multi\r\nline', 'ünï', '=1+1'];
    const [parsed] = parseCsv(csvRow(values));
    expect(parsed).toEqual(['plain', 'a,b', 'q "x"', 'multi\r\nline', 'ünï', "'=1+1"]);
  });
});

describe('ZipWriter', () => {
  async function build(files: [string, (string | Buffer)[]][]): Promise<Buffer> {
    const parts: Buffer[] = [];
    const zip = new ZipWriter({ write: async (b) => void parts.push(Buffer.from(b)) });
    for (const [name, chunks] of files) await zip.addFile(name, chunks, new Date(2026, 9, 15, 12, 0, 0));
    await zip.finish();
    return Buffer.concat(parts);
  }

  it('writes an archive that reads back byte for byte, CRCs verified', async () => {
    const big = 'row,with,data\r\n'.repeat(50_000);
    const buf = await build([
      ['timeline.csv', ['﻿title\r\n', big]],
      ['manifest.json', ['{"ok":true}\n']],
      ['empty.json', []],
    ]);
    const files = unzip(buf);
    expect([...files.keys()]).toEqual(['timeline.csv', 'manifest.json', 'empty.json']);
    expect(files.get('timeline.csv')!.toString('utf8')).toBe(`﻿title\r\n${big}`);
    expect(files.get('empty.json')!.length).toBe(0);
    expect(buf.length).toBeLessThan(big.length / 10); // compressed
  });

  it('stores UTF-8 names and content', async () => {
    const files = unzip(await build([['日記.json', ['{"t":"日本語 🚀"}']]]));
    expect(files.get('日記.json')!.toString('utf8')).toBe('{"t":"日本語 🚀"}');
  });

  it('computes standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});
