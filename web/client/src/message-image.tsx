import React, { useState } from 'react';
import { ImageViewer } from './image-viewer';

export function ReplyImage({src, alt = '返回的图片', lowData = false}:{src:string;alt?:string;lowData?:boolean}) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  if (!src) return <span>[图片地址不可用]</span>;
  const preview = src.startsWith('/api/projects/') && src.includes('/image?') ? src.replace('/image?', '/thumbnail?')
    : lowData && /^https?:/i.test(src) ? '' : src;
  return <><button type="button" className="reply-image" aria-label={`预览图片：${alt}`} onClick={() => setOpen(true)}>{failed || !preview ? <span>查看原图：{alt}</span> : <img src={preview} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/>}</button>
    {open && <ImageViewer src={src} alt={alt} onClose={() => setOpen(false)}/>}</>;
}
