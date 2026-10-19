/**
 * CSV for spreadsheets (RFC 4180, CRLF line ends). Pure.
 *
 * A text cell that a spreadsheet would read as a formula — one starting with
 * `=`, `+`, `-`, `@`, a tab or a carriage return — is prefixed with `'`, so
 * opening an export can never run something a window title contained.
 * Numbers are written as numbers and are never prefixed.
 */

/** Written at the start of every CSV file so Excel reads it as UTF-8. */
export const CSV_BOM = '﻿';

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
