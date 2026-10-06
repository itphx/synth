import React, { useId } from 'react';
import { SYNTH_LOGO_PATH } from '@/lib/theme/logo-path';

interface SynthLogoProps {
  className?: string;
  width?: number;
  height?: number;
  /** 'current' — плоский currentColor (по умолчанию, без изменений); 'brand' — декоративный
   * градиент от цвета темы (--primary), для hero-экрана входа. Форма/transform те же. */
  variant?: 'current' | 'brand';
}

export const SynthLogo: React.FC<SynthLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  variant = 'current',
}) => {
  const isBrand = variant === 'brand';
  // useId может содержать символы, недопустимые в CSS url(#...); санитайзим.
  const gradientId = `synth-logo-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 199.85217 237.13795"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Synth logo"
    >
      {isBrand && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: 'color-mix(in oklab, var(--primary) 50%, #ffffff)' }} />
            <stop offset="45%" style={{ stopColor: 'var(--primary)' }} />
            <stop offset="100%" style={{ stopColor: 'color-mix(in oklab, var(--primary) 65%, #000000)' }} />
          </linearGradient>
        </defs>
      )}
      <g transform="translate(-5.0739065,-29.931031)">
        <path fill={isBrand ? `url(#${gradientId})` : 'currentColor'} d={SYNTH_LOGO_PATH} />
      </g>
    </svg>
  );
};