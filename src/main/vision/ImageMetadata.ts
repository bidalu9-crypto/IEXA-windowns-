export interface ImageDimensions { width: number; height: number; }

/** Read dimensions without decoding or resampling the original image bytes. */
export function imageDimensions(data: Buffer, mimeType: string): ImageDimensions | undefined {
  const mime = String(mimeType || '').toLowerCase();
  if ((mime === 'image/png' || data.subarray(1, 4).toString('ascii') === 'PNG') && data.length >= 24) {
    return valid(data.readUInt32BE(16), data.readUInt32BE(20));
  }
  if ((mime === 'image/gif' || data.subarray(0, 3).toString('ascii') === 'GIF') && data.length >= 10) {
    return valid(data.readUInt16LE(6), data.readUInt16LE(8));
  }
  if ((mime === 'image/bmp' || data.subarray(0, 2).toString('ascii') === 'BM') && data.length >= 26) {
    return valid(data.readInt32LE(18), Math.abs(data.readInt32LE(22)));
  }
  if (mime === 'image/jpeg' || (data[0] === 0xff && data[1] === 0xd8)) return jpegDimensions(data);
  return undefined;
}

function jpegDimensions(data: Buffer): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) { offset++; continue; }
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    if (offset + 4 > data.length) return undefined;
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return valid(data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5));
    }
    offset += 2 + length;
  }
  return undefined;
}

function valid(width: number, height: number): ImageDimensions | undefined {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}
