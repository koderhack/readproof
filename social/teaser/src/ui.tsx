import React from 'react';
import {AbsoluteFill, interpolate, spring} from 'remotion';
import type {CSSProperties} from 'react';
import {gold, goldDark, green, greenDark, greenSoft, ink, line, muted, paper} from './theme';
import {FRAUNCES, MONO} from './fonts';

export const easeIn = (frame: number, delay: number, dur = 12) =>
  interpolate(frame, [delay, delay + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

export const easeOut = (frame: number, from: number, dur = 10) =>
  interpolate(frame, [from, from + dur], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

export const pop = (frame: number, delay: number, fps: number) =>
  spring({
    frame: frame - delay,
    fps,
    config: {damping: 240, stiffness: 220, mass: 0.8},
  });

export const popSoft = (frame: number, delay: number, fps: number) =>
  spring({
    frame: frame - delay,
    fps,
    config: {damping: 26, stiffness: 190, mass: 0.7},
  });

export const PaperBackground: React.FC<{children?: React.ReactNode}> = ({children}) => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: paper,
        fontFamily: 'Inter, system-ui, sans-serif',
        color: ink,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(900px 420px at 82% 8%, rgba(248,240,218,.95), transparent 70%), radial-gradient(780px 380px at 8% 92%, rgba(231,242,235,.95), transparent 70%)',
        }}
      />
      {children}
    </AbsoluteFill>
  );
};

export const Kicker: React.FC<{children: React.ReactNode; style?: CSSProperties}> = ({
  children,
  style,
}) => (
  <div
    style={{
      fontFamily: MONO,
      fontSize: 13,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: goldDark,
      fontWeight: 600,
      ...style,
    }}
  >
    {children}
  </div>
);

export const GoldRule: React.FC<{style?: CSSProperties}> = ({style}) => (
  <div
    style={{
      width: 64,
      height: 3,
      borderRadius: 2,
      background: `linear-gradient(90deg, ${gold}, ${goldLine})`,
      ...style,
    }}
  />
);

export const BrandMark: React.FC<{size?: number; style?: CSSProperties}> = ({size = 48, style}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: Math.round(size * 0.28),
      background: `linear-gradient(150deg, ${green}, ${greenDark})`,
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: FRAUNCES,
      fontWeight: 800,
      fontSize: size * 0.52,
      letterSpacing: '-0.02em',
      flex: 'none',
      ...style,
    }}
  >
    R
  </div>
);

export const Wordmark: React.FC<{size?: number; style?: CSSProperties}> = ({size = 30, style}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: size * 0.34, ...style}}>
    <BrandMark size={size * 1.35} />
    <span
      style={{
        fontFamily: FRAUNCES,
        fontWeight: 800,
        fontSize: size,
        letterSpacing: '-0.01em',
        color: ink,
      }}
    >
      ReadProof
    </span>
  </div>
);

export const Proofline: React.FC<{
  items: string[];
  isVertical?: boolean;
  style?: CSSProperties;
}> = ({items, isVertical = false, style}) => (
  <div
    style={{
      display: 'flex',
      gap: isVertical ? 14 : 22,
      flexDirection: isVertical ? 'column' : 'row',
      flexWrap: 'wrap',
      fontSize: 15,
      color: muted,
      ...style,
    }}
  >
    {items.map((it, i) => (
      <span key={i} style={{display: 'inline-flex', alignItems: 'center', gap: 8}}>
        <b style={{color: greenDark}}>✓</b>
        {it}
      </span>
    ))}
  </div>
);

export const UrlPill: React.FC<{style?: CSSProperties}> = ({style}) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 12,
      background: green,
      color: '#fff',
      borderRadius: 14,
      padding: '13px 24px',
      boxShadow: '0 10px 24px rgba(27,94,59,.28)',
      ...style,
    }}
  >
    <span
      style={{
        fontFamily: MONO,
        fontSize: 20,
        fontWeight: 600,
        letterSpacing: '0.02em',
      }}
    >
      readproof.pages.dev
    </span>
    <span style={{color: goldLine, fontWeight: 800, fontSize: 17}}>✓</span>
  </div>
);