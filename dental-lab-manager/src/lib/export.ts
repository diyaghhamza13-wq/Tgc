import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

export type Sheet = { name: string; headers: string[]; rows: (string | number | null)[][] };

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Excel export as SpreadsheetML 2003 (.xls): opened natively by Excel,
 * LibreOffice and Numbers, multiple sheets, Unicode/Arabic safe, no dependency.
 */
export function toSpreadsheetXml(sheets: Sheet[]): string {
  const cell = (v: string | number | null) =>
    typeof v === 'number'
      ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>`
      : `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`;
  const ws = sheets
    .map(
      (s) =>
        `<Worksheet ss:Name="${esc(s.name.slice(0, 31))}"><Table>` +
        `<Row>${s.headers.map((h) => `<Cell ss:StyleID="h"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('')}</Row>` +
        s.rows.map((r) => `<Row>${r.map(cell).join('')}</Row>`).join('') +
        `</Table></Worksheet>`,
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
    `<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>${ws}</Workbook>`
  );
}

export function toHtmlReport(title: string, subtitle: string, sheets: Sheet[], rtl: boolean): string {
  return `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"/>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0B1726;padding:24px}
h1{margin:0;color:#8a6a22;font-size:22px} .sub{color:#666;margin:4px 0 20px}
h2{font-size:15px;margin:22px 0 8px;border-bottom:2px solid #D6AD55;padding-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:11px} th{background:#0B1726;color:#FFD36B;text-align:start;padding:6px}
td{border-bottom:1px solid #e5e5e5;padding:5px} tr:nth-child(even) td{background:#faf7ef}
</style></head><body><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div>
${sheets
  .map(
    (s) =>
      `<h2>${esc(s.name)}</h2><table><thead><tr>${s.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${s.rows
        .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`,
  )
  .join('')}</body></html>`;
}

async function shareText(content: string, fileName: string, mime: string) {
  if (Platform.OS === 'web') {
    const blob = new Blob(['﻿' + content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return;
  }
  const f = new File(Paths.cache, fileName);
  if (f.exists) f.delete();
  f.create();
  f.write(content);
  await Sharing.shareAsync(f.uri, { mimeType: mime, dialogTitle: fileName });
}

export async function exportExcel(fileBase: string, sheets: Sheet[]) {
  await shareText(toSpreadsheetXml(sheets), `${fileBase}.xls`, 'application/vnd.ms-excel');
}

export async function exportPdf(fileBase: string, html: string) {
  if (Platform.OS === 'web') {
    await Print.printAsync({ html });
    return;
  }
  const { uri } = await Print.printToFileAsync({ html });
  await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `${fileBase}.pdf`, UTI: 'com.adobe.pdf' });
}
