import { useTranslation } from 'react-i18next';

interface AvatarPlaceholderProps {
  /** Display name used to derive initials. Falls back to a neutral mark when absent. */
  name?: string | null;
  className?: string;
}

/** Deterministic palette pick so the same name always gets the same colour. */
const COLORS = ['#00694C', '#1D9E75', '#1A2830', '#0B5563', '#3D5A6C'] as const;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = [...parts[0]][0] ?? '';
  const second = parts.length > 1 ? ([...parts[parts.length - 1]][0] ?? '') : '';
  return (first + second).toUpperCase();
}

function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash + ch.codePointAt(0)!) % COLORS.length;
  return COLORS[hash];
}

/**
 * Local avatar placeholder. Replaces the design-tool CDN images that used to be
 * hard-coded into the UI, so the app has no third-party image dependency.
 */
export function AvatarPlaceholder({ name, className = '' }: AvatarPlaceholderProps) {
  const { t } = useTranslation();
  const initials = name ? initialsOf(name) : '';

  if (initials) {
    return (
      <div
        role="img"
        aria-label={t('a11y.userAvatar')}
        className={`w-full h-full flex items-center justify-center text-white font-bold ${className}`}
        style={{ backgroundColor: colorFor(name!) }}
      >
        <span aria-hidden="true">{initials}</span>
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={t('a11y.userAvatar')}
      className={`w-full h-full flex items-center justify-center bg-surface-container-low ${className}`}
    >
      <svg
        aria-hidden="true"
        fill="none"
        height="20"
        viewBox="0 0 24 24"
        width="20"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle cx="7" cy="7" r="3" stroke="#1A2830" strokeWidth="2" />
        <circle cx="17" cy="17" r="3" stroke="#1D9E75" strokeWidth="2" />
        <path d="M10 10L14 14" stroke="#00694C" strokeLinecap="round" strokeWidth="2" />
      </svg>
    </div>
  );
}

export default AvatarPlaceholder;
