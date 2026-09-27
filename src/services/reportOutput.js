/**
 * Turning a report into a file.
 *
 * Two formats, one set of rows. Both come from `runReport`, so a CSV and a PDF
 * of the same report cannot disagree.
 */

const PDFDocument = require('pdfkit');

/**
 * One CSV cell.
 *
 * A cell beginning `= + - @` is prefixed with an apostrophe: spreadsheets treat
 * those as formulas, and a customer whose name starts with "=" is a real thing
 * that should not execute when somebody opens the file.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * The whole CSV.
 *
 * The BOM is what makes Excel open a UTF-8 file as UTF-8 instead of mangling
 * every accented name, and CRLF is what the spec asks for.
 */
function toCsv(result, { includeSummary = true } = {}) {
  const lines = [];

  if (includeSummary) {
    lines.push([result.datasetLabel, result.period].map(csvCell).join(','));
    lines.push(
      ['Rows in this file', result.returned, 'Rows matching', result.total].map(csvCell).join(',')
    );
    if (result.truncated) {
      lines.push(
        csvCell(`Capped at ${result.limit} rows — narrow the range to get the rest`)
      );
    }
    result.totals.forEach((t) => lines.push([t.label, t.value].map(csvCell).join(',')));
    lines.push('');
  }

  lines.push(result.columns.map((c) => csvCell(c.label)).join(','));
  result.rows.forEach((row) => lines.push(row.map(csvCell).join(',')));

  return `﻿${lines.join('\r\n')}`;
}

/**
 * A printable summary.
 *
 * Deliberately a summary and not the whole table: a thousand-row report printed
 * across forty pages is not a document anybody reads. The header carries the
 * totals and the period, the table shows the first page of rows, and the footer
 * says plainly how many were left out and where to get them.
 */
function toPdf(result, { title, generatedBy, settings = {}, compress = true } = {}) {
  const brand = /^#[0-9a-fA-F]{6}$/.test(settings.brandColor || '') ? settings.brandColor : '#2563EB';
  const INK = '#0F172A';
  const MUTED = '#64748B';
  const LINE = '#D7E3F4';

  // `compress` is a hook for tests: PDFKit compresses content streams by
  // default, which makes the text unreadable in the raw bytes.
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, compress });
  const PAGE_RIGHT = doc.page.width - 36;
  const PAGE_BOTTOM = doc.page.height - 50;
  let cursor = 36;

  // ── Header ─────────────────────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 84).fill(brand);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(17)
    .text(title || `${result.datasetLabel} report`, 36, 24);
  doc.font('Helvetica').fontSize(10)
    .text(`${result.period}${result.from ? `  ·  ${result.from} to ${result.to}` : ''}`, 36, 48);
  doc.fontSize(9)
    .text(
      `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${generatedBy ? ` by ${generatedBy}` : ''}`,
      PAGE_RIGHT - 300,
      50,
      { width: 300, align: 'right' }
    );
  cursor = 100;

  // ── Totals ─────────────────────────────────────────────────────────────
  const tiles = [
    { label: 'Rows matching', value: result.total.toLocaleString('en-GB') },
    ...result.totals.map((t) => ({
      label: t.label,
      value: t.money ? `EUR ${Number(t.value).toFixed(2)}` : Number(t.value).toLocaleString('en-GB'),
    })),
  ];
  const tileWidth = Math.min(170, (PAGE_RIGHT - 36) / Math.max(tiles.length, 1) - 8);
  tiles.forEach((tile, i) => {
    const x = 36 + i * (tileWidth + 8);
    doc.roundedRect(x, cursor, tileWidth, 48, 8).fillAndStroke('#F8FAFC', LINE);
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7)
      .text(tile.label.toUpperCase(), x + 10, cursor + 9, { width: tileWidth - 20, characterSpacing: 0.4 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
      .text(tile.value, x + 10, cursor + 22, { width: tileWidth - 20 });
  });
  cursor += 66;

  // ── Table ──────────────────────────────────────────────────────────────
  const columns = result.columns;
  const colWidth = (PAGE_RIGHT - 36) / Math.max(columns.length, 1);

  const drawHead = () => {
    doc.rect(36, cursor, PAGE_RIGHT - 36, 20).fill('#F1F5F9');
    columns.forEach((c, i) => {
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
        .text(c.label.toUpperCase(), 40 + i * colWidth, cursor + 6, {
          width: colWidth - 8,
          ellipsis: true,
          lineBreak: false,
        });
    });
    cursor += 20;
  };

  drawHead();

  let printed = 0;
  for (const row of result.rows) {
    if (cursor + 18 > PAGE_BOTTOM) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 });
      cursor = 36;
      drawHead();
    }
    columns.forEach((c, i) => {
      doc.fillColor(INK).font('Helvetica').fontSize(7.5)
        .text(String(row[i] ?? ''), 40 + i * colWidth, cursor + 4, {
          width: colWidth - 8,
          ellipsis: true,
          lineBreak: false,
        });
    });
    cursor += 16;
    doc.moveTo(36, cursor - 2).lineTo(PAGE_RIGHT, cursor - 2)
      .strokeColor('#EEF2F7').lineWidth(0.5).stroke();
    printed += 1;
  }

  if (printed === 0) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(10)
      .text('Nothing matched this report.', 36, cursor + 10);
    cursor += 30;
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  const left = result.total - printed;
  doc.fillColor(MUTED).font('Helvetica').fontSize(8)
    .text(
      left > 0
        ? `Showing ${printed} of ${result.total} rows. The full set is in the CSV export of the same report.`
        : `Showing all ${printed} row${printed === 1 ? '' : 's'}.`,
      36,
      Math.min(cursor + 10, PAGE_BOTTOM + 10),
      { width: PAGE_RIGHT - 36 }
    );

  return doc;
}

module.exports = { csvCell, toCsv, toPdf };
