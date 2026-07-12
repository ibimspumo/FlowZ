import { Music2, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../persistence/media';
import type { MediaMetadata } from '../types';
import { formatNumber, useI18n } from '../i18n';

function duration(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

export function MediaPreview({ hash, posterHash, metadata, fileName }: { hash: string; posterHash?: string; metadata: MediaMetadata; fileName?: string }) {
  const {t}=useI18n();
  const root = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLMediaElement>(null);
  const [visible, setVisible] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  useEffect(() => setPlaybackError(false), [hash]);
  useEffect(() => {
    const node = root.current; if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting);
      if (!entry.isIntersecting) media.current?.pause();
    }, { rootMargin: '180px' });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  const source = mediaUrl(hash);
  const details = metadata.kind === 'video'
    ? [metadata.width && metadata.height ? `${metadata.width}×${metadata.height}` : '', metadata.fps ? `${formatNumber(metadata.fps,{maximumFractionDigits:2})} fps` : '']
    : [metadata.sampleRate ? `${formatNumber(Math.round(metadata.sampleRate / 1000))} kHz` : '', metadata.channels ? `${metadata.channels} ${t('media.channels')}` : ''];
  return <div className="media-preview" ref={root}>
    {!metadata.playable || playbackError ? <div className="media-playback-warning" role="status">{metadata.playbackWarning ?? t('media.unplayable')}</div> : metadata.kind === 'video'
      ? <video ref={media as React.RefObject<HTMLVideoElement>} src={visible ? source : undefined} poster={posterHash ? mediaUrl(posterHash) : undefined} controls preload={visible ? 'metadata' : 'none'} playsInline onError={() => setPlaybackError(true)} aria-label={fileName ?? t('media.importedVideo')} />
      : <div className="audio-preview"><Music2 size={22} /><audio ref={media as React.RefObject<HTMLAudioElement>} src={visible ? source : undefined} controls preload={visible ? 'metadata' : 'none'} onError={() => setPlaybackError(true)} aria-label={fileName ?? t('media.importedAudio')} /></div>}
    <div className="media-facts"><span>{metadata.kind === 'video' ? <Video size={11} /> : <Music2 size={11} />}{duration(metadata.durationSeconds)}</span>{details.filter(Boolean).map((item) => <span key={String(item)}>{item}</span>)}<span>{metadata.codecs.join(' + ')}</span></div>
  </div>;
}
