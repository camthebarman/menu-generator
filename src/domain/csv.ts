import Papa from 'papaparse';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  errors: string[];
}

export function parseCsv(text: string): ParsedCsv {
  const errors: string[] = [];
  if (text.length > MAX_IMPORT_BYTES) return { headers: [], rows: [], errors: [`File is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`] };
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
  for (const e of res.errors.slice(0, 10)) errors.push(`Row ${(e.row ?? 0) + 2}: ${e.message}`);
  if (res.data.length > MAX_IMPORT_ROWS) errors.push(`Too many rows (${res.data.length}); limit is ${MAX_IMPORT_ROWS}`);
  return { headers: res.meta.fields ?? [], rows: res.data.slice(0, MAX_IMPORT_ROWS), errors };
}

/** Neutralize spreadsheet formula injection: prefix risky leading characters with a quote. */
export function safeCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    const s = safeCell(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n') + '\r\n';
}

export function contentHash(text: string): string {
  // FNV-1a 64-bit-ish via two 32-bit lanes; stable across runtimes, for import idempotency.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
}

export function downloadText(filename: string, text: string, mime = 'text/csv') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
