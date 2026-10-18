/**
 * Builds small real files of each supported type, for parser tests and for the
 * sample files in docs/rag-system/samples (scripts/rag-samples.js).
 * Uses libraries the backend already has: pdfkit, jszip (via mammoth), exceljs.
 */

const PDFDocument = require('pdfkit');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

function pdf() {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const parts = [];
    doc.on('data', (b) => parts.push(b));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    const pages = [
      ['Praslin Guide', 'Praslin is the second largest island of the Seychelles.', 'The Vallée de Mai is home to the coco de mer palm.'],
      ['Getting There', 'The Cat Cocos ferry from Mahé takes about one hour.', 'Air Seychelles flies between the islands in about 15 minutes.'],
      ['Beaches', 'Anse Lazio and Anse Georgette are among the best beaches in the world.', 'Snorkelling is calmest in April–May and October–November.'],
    ];
    pages.forEach(([title, ...lines], i) => {
      if (i) doc.addPage();
      doc.fontSize(9).text('Holidays Seychelles · Island Guide');
      doc.moveDown();
      doc.fontSize(18).text(title);
      doc.moveDown();
      lines.forEach((l) => doc.fontSize(12).text(l).moveDown());
      doc.fontSize(9).text(`Page ${i + 1} of ${pages.length}`);
    });
    doc.end();
  });
}

async function docx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (t) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const body = [
    p('Cancellation Policy', 'Heading1'),
    p('Bookings cancelled more than 30 days before arrival receive a full refund.'),
    p('Late cancellations', 'Heading2'),
    p('Cancellations within 7 days of arrival are non-refundable.'),
    `<w:tbl><w:tr>${cell('Notice')}${cell('Refund')}</w:tr><w:tr>${cell('30+ days')}${cell('100%')}</w:tr><w:tr>${cell('8–29 days')}${cell('50%')}</w:tr></w:tbl>`,
  ].join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function xlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Transfers');
  ws.addRow(['From', 'To', 'Vehicle', 'Price (EUR)']);
  ws.addRow(['Seychelles International Airport', 'Victoria', 'Sedan', 49]);
  ws.addRow(['Seychelles International Airport', 'Beau Vallon', 'Minivan', 65]);
  ws.addRow(['Praslin Jetty', 'Anse Lazio', 'Sedan', 40]);
  const hidden = wb.addWorksheet('Internal');
  hidden.state = 'hidden';
  hidden.addRow(['Secret', 'Margin']);
  hidden.addRow(['x', 0.3]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function csv() {
  return Buffer.from('﻿Excursion;Island;Duration;Price\nVallée de Mai walk;Praslin;Half day;85\n"Sunset cruise; catamaran";Mahé;3 hours;120\n', 'utf8');
}

function txt() {
  return Buffer.from('Visitor permits\n\nVisitors from most countries receive a free visitor permit on arrival.\n\nYou need a passport valid for six months and a return ticket.\n', 'utf8');
}

module.exports = { pdf, docx, xlsx, csv, txt };
