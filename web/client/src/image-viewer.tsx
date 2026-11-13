import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import './image-viewer.css';

type View = { scale: number; x: number; y: number };
const initialView: View = { scale: 1, x: 0, y: 0 };

export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const toolbarTouch = useRef<{ id: number; x: number; y: number } | null>(null);
  const [view, setView] = useState(initialView);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  function zoom(factor: number) {
    setView(current => {
      const scale = Math.max(1, Math.min(5, current.scale * factor));
      const ratio = scale / current.scale;
      return scale === 1 ? initialView : { scale, x: current.x * ratio, y: current.y * ratio };
    });
  }

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.showModal();
    const viewport = stage.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.2 : 1 / 1.2);
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', wheel);
      document.body.style.overflow = overflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  function pointerMove(event: React.PointerEvent) {
    const points = pointers.current;
    const previous = points.get(event.pointerId);
    if (!previous) return;
    const before = [...points.values()];
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = [...points.values()];
    if (points.size === 2) {
      const distance = (values: typeof before) => Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
      const previousDistance = distance(before);
      if (!previousDistance) return;
      setView(current => {
        const scale = Math.max(1, Math.min(5, current.scale * distance(after) / previousDistance));
        const ratio = scale / current.scale;
        return scale === 1 ? initialView : {
          scale,
          x: current.x * ratio + (event.clientX - previous.x) / 2,
          y: current.y * ratio + (event.clientY - previous.y) / 2,
        };
      });
    } else if (points.size === 1) {
      setView(current => current.scale === 1 ? current : {
        ...current, x: current.x + event.clientX - previous.x, y: current.y + event.clientY - previous.y,
      });
    }
  }

  return createPortal(<dialog ref={dialog} className="image-viewer" aria-label={`图片预览：${alt}`}
    onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose}
    onKeyDown={event => {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25); }
      if (event.key === '-') { event.preventDefault(); zoom(0.8); }
      if (event.key === '0') setView(initialView);
    }}>
    <div className="image-viewer-toolbar"
      onTouchStart={event => {
        const touch = event.touches[0];
        toolbarTouch.current = event.touches.length === 1 ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
      }}
      onTouchEnd={event => {
        event.preventDefault();
        const touch = toolbarTouch.current;
        toolbarTouch.current = null;
        const ended = Array.from(event.changedTouches).find(point => point.identifier === touch?.id);
        if (touch && ended && Math.hypot(ended.clientX - touch.x, ended.clientY - touch.y) < 10) {
          (event.target as Element).closest('button')?.click();
        }
      }}
      onTouchCancel={() => { toolbarTouch.current = null; }}>
      <button type="button" aria-label="缩小图片" disabled={!loaded || view.scale === 1} onClick={() => zoom(0.8)}><ZoomOut size={20}/></button>
      <span aria-live="polite">{Math.round(view.scale * 100)}%</span>
      <button type="button" aria-label="放大图片" disabled={!loaded || view.scale === 5} onClick={() => zoom(1.25)}><ZoomIn size={20}/></button>
      <button type="button" aria-label="重置图片" disabled={!loaded} onClick={() => setView(initialView)}><RotateCcw size={20}/></button>
      <button type="button" aria-label="关闭图片预览" autoFocus onClick={onClose}><X size={22}/></button>
    </div>
    <div ref={stage} className={'image-viewer-stage' + (view.scale > 1 ? ' zoomed' : '')}
      onDoubleClick={() => loaded && (view.scale > 1 ? setView(initialView) : zoom(2))}
      onPointerDown={event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }}
      onPointerMove={pointerMove}
      onPointerUp={event => pointers.current.delete(event.pointerId)}
      onPointerCancel={event => pointers.current.delete(event.pointerId)}
      onLostPointerCapture={event => pointers.current.delete(event.pointerId)}>
      {!loaded && !failed && <p role="status">正在加载原图…</p>}
      {failed ? <p role="alert">图片加载失败，请关闭后重试。</p> : <img src={src} alt={alt} draggable={false}
        referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setFailed(true); }}
        style={{ visibility: loaded ? 'visible' : 'hidden', transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}/>}
    </div>
  </dialog>, document.body);
}
