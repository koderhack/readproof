import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {easeIn, easeOut, PaperBackground, Proofline, pop, popSoft} from '../ui';
import {gold, goldDark, goldLine, green, greenDark, greenSoft, ink, line, muted} from '../theme';
import {FRAUNCES, MONO} from '../fonts';

const GRAY_BARS = [1, 0.9, 0.98, 0.82, 0.95, 0.72, 0.9, 0.66, 0.86, 0.58];

const Book: React.FC<{frame: number; fps: number}> = ({frame, fps}) => {
  const intro = pop(frame, 6, fps);
  const flip = popSoft(frame, 30, fps);
  const pageIn = easeIn(frame, 66, 14);
  const pageFade = 0.85 + 0.15 * pageIn;

  return (
    <div
      style={{
        position: 'relative',
        width: 660,
        height: 460,
        perspective: 1400,
        transform: `translateY(${(1 - intro) * 36}px) scale(${0.92 + 0.08 * intro})`,
        opacity: intro,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: '#fff',
          border: `1px solid ${line}`,
          borderRadius: 20,
          boxShadow: '0 24px 64px rgba(23,32,43,.14)',
          overflow: 'hidden',
          opacity: pageFade,
        }}
      >
        <div style={{position: 'absolute', inset: 0, padding: '52px 60px 44px'}}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 14,
              letterSpacing: '0.24em',
              textTransform: 'uppercase',
              color: goldDark,
            }}
          >
            Chapter I — Down the Rabbit-Hole
          </div>
          <div
            style={{
              fontFamily: FRAUNCES,
              fontWeight: 800,
              fontStyle: 'italic',
              fontSize: 44,
              lineHeight: 1.15,
              letterSpacing: '-0.02em',
              color: greenDark,
              margin: '14px 0 26px',
            }}
          >
            Alice&apos;s Adventures in Wonderland
          </div>
          <div style={{display: 'grid', gap: 16}}>
            {GRAY_BARS.map((w, i) => (
              <div
                key={i}
                style={{
                  height: 11,
                  width: `${w * 100}%`,
                  borderRadius: 6,
                  background: i === 4 ? goldLine : lineSoft,
                }}
              />
            ))}
          </div>
          <div
            style={{
              marginTop: 30,
              fontFamily: MONO,
              fontSize: 13,
              letterSpacing: '0.12em',
              color: muted,
              textTransform: 'uppercase',
            }}
          >
            <b style={{color: goldDark}}>✓</b> · a talking rabbit in a waistcoat
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          transformOrigin: 'left center',
          transform: `rotateY(${(1 - flip) * -118}deg)`,
          borderRadius: 20,
          overflow: 'hidden',
          background: `linear-gradient(150deg, ${green}, ${greenDark})`,
          boxShadow: '0 18px 48px rgba(18,63,39,.4)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 30,
            background: `linear-gradient(180deg, ${gold}, ${goldDark})`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '0 74px',
          }}
        >
          <div
            style={{
              fontFamily: MONO,
              fontSize: 15,
              letterSpacing: '0.2em',
              color: '#8FB6A0',
              textTransform: 'uppercase',
              marginBottom: 16,
            }}
          >
            ReadProof Classics
          </div>
          <div
            style={{
              fontFamily: FRAUNCES,
              fontWeight: 800,
              fontSize: 46,
              lineHeight: 1.12,
              color: '#fff',
              letterSpacing: '-0.02em',
            }}
          >
            Alice&apos;s Adventures
          </div>
          <div
            style={{
              fontFamily: FRAUNCES,
              fontWeight: 700,
              fontStyle: 'italic',
              fontSize: 30,
              color: goldLine,
              marginTop: 8,
            }}
          >
            in Wonderland
          </div>
          <div
            style={{
              height: 2,
              width: 90,
              background: gold,
              margin: '22px 0',
            }}
          />
          <div style={{fontFamily: MONO, fontSize: 16, letterSpacing: '0.18em', color: '#8FB6A0'}}>
            LEWIS CARROLL
          </div>
        </div>
      </div>
    </div>
  );
};

export const Scene1Book: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const vertical = height > width;

  const fadeIn = easeIn(frame, 0, 10);
  const fadeOut = easeOut(frame, 150, 10);
  const sceneOpacity = Math.min(fadeIn, fadeOut);

  const eyebrow = pop(frame, 8, fps);
  const h1 = pop(frame, 14, fps);
  const h2 = pop(frame, 24, fps);
  const pl = easeIn(frame, 38, 12);

  return (
    <PaperBackground>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: sceneOpacity,
          padding: vertical ? '60px 70px' : '0 120px',
          display: 'flex',
          flexDirection: vertical ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: vertical ? 56 : 84,
        }}
      >
        <div
          style={{
            flex: vertical ? 'none' : 1,
            maxWidth: vertical ? 860 : 780,
            display: 'flex',
            flexDirection: 'column',
            textAlign: vertical ? 'center' : 'left',
            alignItems: vertical ? 'center' : 'flex-start',
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: MONO,
              fontSize: 14,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: greenDark,
              background: greenSoft,
              border: '1px solid #CFE3D6',
              borderRadius: 999,
              padding: '8px 16px',
              fontWeight: 600,
              opacity: eyebrow,
              transform: `translateY(${(1 - eyebrow) * 14}px)`,
            }}
          >
            Reading · Understanding · Proof
          </div>
          <h1
            style={{
              margin: '26px 0 10px',
              fontFamily: FRAUNCES,
              fontWeight: 800,
              fontSize: vertical ? 96 : 92,
              lineHeight: 1.04,
              letterSpacing: '-0.025em',
              color: ink,
            }}
          >
            <span style={{display: 'block', opacity: h1, transform: `translateY(${(1 - h1) * 30}px)`}}>
              Read a real book.
            </span>
            <span
              style={{
                display: 'block',
                fontStyle: 'italic',
                color: greenDark,
                opacity: h2,
                transform: `translateY(${(1 - h2) * 30}px)`,
              }}
            >
              Prove you understood it.
            </span>
          </h1>
          <div
            style={{
              marginTop: 30,
              opacity: pl,
              transform: `translateY(${(1 - pl) * 20}px)`,
            }}
          >
            <Proofline
              isVertical={vertical}
              items={['Real books, real chapters', 'Comprehension challenges', 'Verifiable certificates']}
            />
          </div>
        </div>

        <div
          style={{
            flex: 'none',
            transform: vertical ? 'scale(0.82)' : undefined,
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <Book frame={frame} fps={fps} />
        </div>
      </div>
    </PaperBackground>
  );
};