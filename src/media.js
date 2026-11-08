'use strict';
/** Reads just enough of an image / video header to tell what a file really is. */

function sniff(buf) {
  if (!buf || buf.length < 12) return { type: null };
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf.length >= 24) {
    return { type: 'png', mime: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the markers until a start-of-frame (SOFn) segment
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { type: 'jpeg', mime: 'image/jpeg', ext: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { type: 'jpeg', mime: 'image/jpeg', ext: 'jpg' };
  }
  // MP4 / MOV: "ftyp" box
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return { type: 'mp4', mime: 'video/mp4', ext: 'mp4' };
  // things people paste by mistake
  const head = buf.slice(0, 200).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head')) return { type: 'html' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { type: 'webp' };
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return { type: 'gif' };
  return { type: null };
}

/**
 * Checks a photo against what the Telegram Ads docs ask for (JPEG / PNG, 5 MB, at least 640 px wide, 16:9).
 * Returns { info, notes }; throws an Error with a clear reason when the file cannot work.
 */
function checkPhoto(buf, where = 'image') {
  const info = sniff(buf);
  if (info.type === 'html') throw new Error(`${where} is a web page, not an image. Open the image on its own and copy the "Direct link" (it ends in .jpg or .png), not the share-page link`);
  if (info.type === 'webp' || info.type === 'gif') throw new Error(`${where} is a ${info.type.toUpperCase()} file. Telegram accepts only JPEG or PNG, so convert it first`);
  if (info.type !== 'jpeg' && info.type !== 'png') throw new Error(`${where} is not a JPEG or PNG image`);
  const notes = [];
  if (info.width && info.width < 640) throw new Error(`${where} is only ${info.width}px wide. Telegram needs at least 640px`);
  if (info.width && info.height) {
    const ratio = info.width / info.height;
    if (Math.abs(ratio - 16 / 9) / (16 / 9) > 0.05) notes.push(`image is ${info.width}x${info.height}; Telegram asks for a 16:9 photo (for example 1280x720), so it may be cropped or rejected`);
  }
  return { info, notes };
}

module.exports = { sniff, checkPhoto };
