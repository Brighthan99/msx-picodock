// SPDX-License-Identifier: GPL-2.0-only
//
// pdfwrite.js — 인쇄가 만드는 PDF 두 가지를 손으로 쓴다.
//
//   pagesPdf  그린 페이지(그림)들을 한 장에 하나씩. Pillow 의 save(..., save_all)
//             을 대신한다. Pillow 는 RGB 를 JPEG 로 넣는데, 여기 페이지는 흑백
//             선화라 무손실(Flate) 회색이 더 작고 더 또렷하다. 페이지 크기는 같은
//             해상도(dpi)로 계산해서 인쇄 배율이 같다.
//   textPdf   --print pdf: 글자를 Courier 10pt 로 조판. reportlab 을 대신한다 -
//             PDF 에 원래 들어 있는 글꼴이라 심을 것이 없다.

import zlib from 'node:zlib';

function build(objects) {
  // objects[i] 는 i+1 번 객체의 몸통 (Buffer 또는 문자열).
  const head = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const parts = [head];
  const offsets = [];
  let pos = head.length;
  objects.forEach((body, i) => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
    const pre = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const post = Buffer.from('\nendobj\n', 'latin1');
    offsets.push(pos);
    parts.push(pre, b, post);
    pos += pre.length + b.length + post.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
                ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

function stream(dict, data) {
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
                        data, Buffer.from('\nendstream', 'latin1')]);
}

const pt = (px, dpi) => Math.round((px * 72 / dpi) * 1000) / 1000;

/** 회색 그림들 -> PDF. 한 그림이 한 페이지, `dpi` 로 크기를 잰다. */
export function pagesPdf(images, dpi = 300) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null];
  const kids = [];
  for (const img of images) {
    const imgNo = objs.length + 1;
    objs.push(stream(`/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} `
      + '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
    zlib.deflateSync(Buffer.from(img.data), { level: 9 })));
    const w = pt(img.width, dpi), h = pt(img.height, dpi);
    const content = Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`, 'latin1');
    const cNo = objs.length + 1;
    objs.push(stream('', content));
    kids.push(objs.length + 1);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] `
      + `/Resources << /XObject << /Im0 ${imgNo} 0 R >> >> /Contents ${cNo} 0 R >>`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  return build(objs);
}

//: US Letter, points. reportlab 의 letter 와 같다.
export const LETTER = [612, 792];

/** PDF 문자열 리터럴. Courier(WinAnsi) 에 없는 글자는 '?'. */
function pdfString(s) {
  let out = '(';
  for (const ch of s) {
    let c = ch.codePointAt(0);
    if (c > 0xff) c = 0x3f;
    const b = String.fromCharCode(c);
    out += b === '(' || b === ')' || b === '\\' ? `\\${b}` : b;
  }
  return `${out})`;
}

/**
 * 줄들을 Courier 로 조판한다. `pages` 는 [[x, y, 글], ...] 의 목록 (포인트, 아래가 0).
 * 자리는 부르는 쪽이 정한다 - reportlab 코드가 하던 계산 그대로 (printrender.js).
 */
export function textPdf(pages, { font = 'Courier', size = 10, pageSize = LETTER } = {}) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null,
                `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`];
  const kids = [];
  for (const lines of pages) {
    const ops = lines.map(([x, y, s]) => `BT /F1 ${size} Tf ${x} ${y} Td ${pdfString(s)} Tj ET`).join('\n');
    const cNo = objs.length + 1;
    objs.push(stream('', Buffer.from(ops, 'latin1')));
    kids.push(objs.length + 1);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageSize[0]} ${pageSize[1]}] `
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${cNo} 0 R >>`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  return build(objs);
}
