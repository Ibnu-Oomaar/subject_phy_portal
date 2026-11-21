import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';

export type ColumnFormat = 'text' | 'marks' | 'percent' | 'int';

export interface ColumnDef {
  header: string;
  key: string;
  width?: number;
  format?: ColumnFormat;
  align?: 'left' | 'center' | 'right';
}

export type CellValue = string | number | null | undefined;

export interface TableOptions {
  title: string;
  /** shown under the title, e.g. "Academic year 2026/2027 - Section 1B" */
  subtitle?: string;
  columns: ColumnDef[];
  rows: Array<Record<string, CellValue>>;
  /** number of leftmost columns kept visible while scrolling horizontally */
  freezeColumns?: number;
}

const HEADER_ROW = 4;
const NUMBER_FORMATS: Record<ColumnFormat, string | undefined> = { text: undefined, marks: '0.00', percent: '0.00', int: '0', };

/**
 * Spreadsheet programs run text that starts with = + - @ as a formula. Student names and exam names are typed by
 * people, so they are neutralised before being written to a file someone will open in Excel ("CSV injection").
 */
export function safeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

const sheetName = (name: string): string => name.replace(/[\\/*?:[\]]/g, '-').slice(0, 31) || 'Sheet';

@Injectable()
export class ExcelService {
  createWorkbook(): ExcelJS.Workbook {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Physics Data Entry Portal';
    wb.created = new Date();
    return wb;
  }

  /** A titled, filterable table with a styled header row and frozen panes. */
  addTable(wb: ExcelJS.Workbook, name: string, opts: TableOptions): ExcelJS.Worksheet {
    let unique = sheetName(name);
    for (let i = 2; wb.getWorksheet(unique); i++) unique = `${sheetName(name).slice(0, 28)} ${i}`;
    const ws = wb.addWorksheet(unique);
    const { columns } = opts;

    ws.getCell('A1').value = safeText(opts.title);
    ws.getCell('A1').font = { bold: true, size: 14 };
    if (opts.subtitle) {
      ws.getCell('A2').value = safeText(opts.subtitle);
      ws.getCell('A2').font = { color: { argb: 'FF6B7280' }, size: 10 };
    }

    columns.forEach((col, i) => {
      const cell = ws.getCell(HEADER_ROW, i + 1);
      cell.value = col.header;
      cell.font = { bold: true, color: { argb: 'FF111827' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } } };
      cell.alignment = { vertical: 'middle', horizontal: col.align ?? (col.format && col.format !== 'text' ? 'right' : 'left'), wrapText: true };
      ws.getColumn(i + 1).width = col.width ?? Math.max(12, Math.min(40, col.header.length + 4));
    });
    ws.getRow(HEADER_ROW).height = 30;

    opts.rows.forEach((row, r) => {
      columns.forEach((col, c) => {
        const raw = row[col.key];
        const cell = ws.getCell(HEADER_ROW + 1 + r, c + 1);
        if (raw === null || raw === undefined || raw === '') return; // blank stays blank: missing is never written as 0
        if (typeof raw === 'number') {
          cell.value = raw;
          const fmt = NUMBER_FORMATS[col.format ?? 'marks'];
          if (fmt) cell.numFmt = fmt;
          cell.alignment = { horizontal: col.align ?? 'right' };
        } else {
          cell.value = safeText(raw);
          if (col.align) cell.alignment = { horizontal: col.align };
        }
      });
    });

    if (!opts.rows.length) {
      const note = ws.getCell(HEADER_ROW + 1, 1);
      note.value = 'No records match this selection.';
      note.font = { italic: true, color: { argb: 'FF6B7280' } };
    }

    ws.views = [{ state: 'frozen', ySplit: HEADER_ROW, xSplit: opts.freezeColumns ?? 0 }];
    ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW, column: columns.length } };
    ws.pageSetup = { orientation: columns.length > 7 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    return ws;
  }

  /** Label/value pairs (e.g. a student summary or class statistics). */
  addKeyValues(wb: ExcelJS.Workbook, name: string, title: string, pairs: Array<[string, CellValue]>, subtitle?: string): ExcelJS.Worksheet {
    const ws = wb.addWorksheet(sheetName(name));
    ws.getCell('A1').value = safeText(title);
    ws.getCell('A1').font = { bold: true, size: 14 };
    if (subtitle) {
      ws.getCell('A2').value = safeText(subtitle);
      ws.getCell('A2').font = { color: { argb: 'FF6B7280' }, size: 10 };
    }
    ws.getColumn(1).width = 34;
    ws.getColumn(2).width = 46;
    pairs.forEach(([label, value], i) => {
      const a = ws.getCell(HEADER_ROW + i, 1);
      a.value = label;
      a.font = { bold: true };
      const b = ws.getCell(HEADER_ROW + i, 2);
      if (value === null || value === undefined || value === '') return;
      if (typeof value === 'number') {
        b.value = value;
        b.numFmt = Number.isInteger(value) ? '0' : '0.00';
        b.alignment = { horizontal: 'left' };
      } else {
        b.value = safeText(value);
      }
    });
    return ws;
  }

  async toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A filename that is safe in a Content-Disposition header and on every operating system. */
export function exportFilename(...parts: string[]): string {
  const name = parts
    .join('_')
    .replace(/[\/\\]/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${name || 'export'}.xlsx`;
}
