import React, { useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';

export function imageSource(value: string, projectId: string) {
  if (/^https?:\/\//i.test(value)) return /\.(png|jpe?g|gif|webp|avif|bmp)(?:[?#].*)?$/i.test(value) ? value : '';
  if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^(file:\/\/|sandbox:)/i.test(value)) return '';
  if (!value || value.startsWith('//') || !/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(value)) return '';
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return ''; }
  return `/api/projects/${encodeURIComponent(projectId)}/image?path=${encodeURIComponent(decoded)}`;
}
function ReplyImage({src, alt = '返回的图片'}:{src:string;alt?:string}) {
  const [failed, setFailed] = useState(false);
  if (!src) return <span>[图片地址不可用]</span>;
  return <a className="reply-image" href={src} target="_blank" rel="noopener noreferrer">{failed ? <span>图片暂不可用，点击重试：{alt}</span> : <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/>}</a>;
}
export function ReplyMarkdown({text, projectId}:{text:string;projectId:string}) {
  return <ReactMarkdown urlTransform={(url, key) => {
    // Preserve normal remote Markdown images, including image URLs without extensions.
    if (key === 'src' && /^https?:\/\//i.test(url)) return url;
    return imageSource(url, projectId) || defaultUrlTransform(url);
  }} components={{
    img: ({src,alt}) => <ReplyImage key={src} src={src || ''} alt={alt}/>,
    a: ({href,children}) => {
      const image = href?.startsWith(`/api/projects/${encodeURIComponent(projectId)}/image?`) || (href && imageSource(href, projectId));
      return image ? <ReplyImage src={href || ''} alt={typeof children === 'string' ? children : '返回的图片'}/> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
  }}>{text}</ReactMarkdown>;
}

export function ReturnedImage({value,projectId}:{value:string;projectId:string}) {
  return <ReplyImage src={imageSource(value,projectId)}/>;
}
