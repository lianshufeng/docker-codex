import { HttpError, requireValue } from './storage.mjs';

export function decodeImages(images = []) {
  requireValue(Array.isArray(images) && images.length <= 4, '每条消息最多附带 4 张图片');
  return images.map(image => {
    requireValue(typeof image === 'string', '图片格式无效');
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    requireValue(match, '仅支持 PNG、JPEG、WebP 和 GIF 图片');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 2 * 1024 * 1024) throw new HttpError(413, '单张图片不能超过 2 MB');
    const type = match[1];
    const valid = type === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : type === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : type === 'gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    requireValue(valid && bytes.toString('base64') === match[2], '图片内容与格式不匹配');
    return { bytes, extension: type === 'jpeg' ? 'jpg' : type };
  });
}
