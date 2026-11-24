import type { Repository, SourceLines } from './repository.ts';

type PageCursor = { line: number; column: number };

export function sourcePage(result: Awaited<ReturnType<Repository['readLines']>>, maxBytes?: number, startColumn = 1) {
  const { path, sha256, totalLines, lines } = result;
  const page: { line: number; text: string; startColumn?: number; endColumn?: number }[] = [];
  let nextCursor: PageCursor | null = null;
  let evidence: SourceLines | null = null;
  let remaining = maxBytes ? Math.max(256, maxBytes - 512) : Infinity;
  if (startColumn > Math.max(1, lines[0].text.length)) throw new Error('The source column is outside the first line.');
  for (const row of lines) {
    const column = page.length ? 1 : startColumn;
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (column === 1 && bytes <= remaining) {
      page.push(row);
      remaining -= bytes;
      evidence = { path, sha256, startLine: page[0].line, endLine: row.line };
      continue;
    }
    if (page.length) {
      nextCursor = { line: row.line, column: 1 };
      break;
    }

    const start = column - 1;
    let end = row.text.length;
    let low = start;
    while (low < end) {
      const middle = Math.ceil((low + end) / 2);
      if (Buffer.byteLength(JSON.stringify(row.text.slice(start, middle))) + 64 <= remaining) low = middle;
      else end = middle - 1;
    }
    end = low;
    if (end > start && /[\uD800-\uDBFF]/.test(row.text[end - 1]) && /[\uDC00-\uDFFF]/.test(row.text[end] ?? '')) end--;
    page.push({ line: row.line, text: row.text.slice(start, end), startColumn: column, endColumn: end });
    nextCursor = end < row.text.length ? { line: row.line, column: end + 1 }
      : row.line < result.endLine ? { line: row.line + 1, column: 1 } : null;
    break;
  }
  return { path, sha256, totalLines, startLine: page[0].line, endLine: page.at(-1)!.line,
    lines: page, nextCursor, evidence, truncated: nextCursor !== null || evidence === null };
}
