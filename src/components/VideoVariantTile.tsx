import { useI18n } from '../i18n';

export function VideoVariantTile({
  src,
  poster,
  index,
  active,
  onSelect,
}: {
  src: string;
  poster?: string;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="fanout-video">
      <video
        src={src}
        poster={poster}
        muted
        playsInline
        preload="metadata"
        controls
        aria-label={t('video.variantPlay',{number:index+1})}
      />
      <button type="button" className="fanout-select" disabled={active} onClick={onSelect}>
        {active ? t('video.variantActive') : t('video.variantChoose',{number:index+1})}
      </button>
    </div>
  );
}
