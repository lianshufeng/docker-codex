import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { ReplyImage } from './message-image';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import './highlight-theme.css';
import './markdown.css';

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [
  rehypeKatex,
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
];

export function imageSource(value: string, projectId: string) {
  if (/^https?:\/\//i.test(value)) return /\.(png|jpe?g|gif|webp|avif|bmp)(?:[?#].*)?$/i.test(value) ? value : '';
  if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^(file:\/\/|sandbox:|[a-z]:[\\/])/i.test(value)) return '';
  if (!value || value.startsWith('//') || !/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(value)) return '';
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return ''; }
  return `/api/projects/${encodeURIComponent(projectId)}/image?path=${encodeURIComponent(decoded)}`;
}
export function ReplyMarkdown({text, projectId, lowData, label}:{text:string;projectId:string;lowData?:boolean;label:React.ReactNode}) {
  const footnotePrefix = `reply-${useId()}-`;
  const content = useRef<HTMLDivElement>(null);
  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(''), 2000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  function copyReply() {
    const selection = window.getSelection();
    if (!selection || !content.current) return;
    const previous = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
    const range = document.createRange();
    range.selectNodeContents(content.current);
    try {
      selection.removeAllRanges();
      selection.addRange(range);
      // Native selection copy supplies both formatted HTML and plain text, including over HTTP.
      setCopyStatus(document.execCommand('copy') ? '已复制' : '复制失败');
    } catch {
      setCopyStatus('复制失败');
    } finally {
      selection.removeAllRanges();
      previous.forEach(saved => selection.addRange(saved));
    }
  }

  return <>
    <div className="agent-label">
      {label}
      {text.trim() && <button type="button" className="icon-button reply-copy" aria-label="复制回复内容" onClick={copyReply}>
        {copyStatus === '已复制' ? <Check size={14}/> : <Copy size={14}/>}
        <span aria-live="polite">{copyStatus || '复制'}</span>
      </button>}
    </div>
    <div className="markdown" ref={content}><ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} remarkRehypeOptions={{ clobberPrefix: footnotePrefix }} urlTransform={(url, key) => {
    // Preserve normal remote Markdown images, including image URLs without extensions.
    if (key === 'src' && /^https?:\/\//i.test(url)) return url;
    return imageSource(url, projectId) || defaultUrlTransform(url);
  }} components={{
    img: ({src,alt}) => <ReplyImage key={src} src={src || ''} alt={alt} lowData={lowData}/>,
    table: ({children}) => <div className="markdown-table" role="region" aria-label="表格" tabIndex={0}><table>{children}</table></div>,
    a: ({href,children,node,...props}) => {
      const image = href?.startsWith(`/api/projects/${encodeURIComponent(projectId)}/image?`) || (href && imageSource(href, projectId));
      return image ? <ReplyImage src={href || ''} lowData={lowData} alt={typeof children === 'string' ? children : '返回的图片'}/> : <a {...props} href={href} target={href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>;
    },
    }}>{text}</ReactMarkdown></div>
  </>;
}

export function ReturnedImage({value,projectId,lowData}:{value:string;projectId:string;lowData?:boolean}) {
  return <ReplyImage src={imageSource(value,projectId)} lowData={lowData}/>;
}
