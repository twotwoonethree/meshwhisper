import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";

// ---------------------------------------------------------------------------
// Deterministic pseudo-random number generator (mulberry32)
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface MeshNode {
  x: number;
  y: number;
  radius: number;
  speedX: number;
  speedY: number;
  phase: number;
}

// ---------------------------------------------------------------------------
// Generate mesh nodes deterministically
// ---------------------------------------------------------------------------
const NODE_COUNT = 30;
const CONNECTION_DISTANCE = 340;

function generateNodes(seed: number): MeshNode[] {
  const rng = mulberry32(seed);
  const nodes: MeshNode[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    nodes.push({
      x: rng() * 1920,
      y: rng() * 1080,
      radius: 2 + rng() * 3,
      speedX: (rng() - 0.5) * 0.6,
      speedY: (rng() - 0.5) * 0.6,
      phase: rng() * Math.PI * 2,
    });
  }
  return nodes;
}

// Use a different seed from Scene 1 for variety
const NODES = generateNodes(77);

// ---------------------------------------------------------------------------
// Pillar config
// ---------------------------------------------------------------------------
const PILLARS: { text: string; color: string }[] = [
  { text: "Free.", color: "#ffffff" },
  { text: "Secure.", color: "#00d4ff" },
  { text: "Serverless.", color: "#7b2fbe" },
  { text: "Forever.", color: "#ffd700" },
];

const PILLAR_STAGGER = 15; // frames between each pillar appearing
const FONT_FAMILY =
  "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const MeshBackground: React.FC<{
  frame: number;
  fps: number;
  opacity: number;
}> = ({ frame, fps, opacity }) => {
  const positions = NODES.map((node) => {
    const t = frame / fps;
    const x =
      node.x +
      Math.sin(t * node.speedX * 2 + node.phase) * 35 +
      Math.cos(t * 0.3 + node.phase * 1.7) * 18;
    const y =
      node.y +
      Math.cos(t * node.speedY * 2 + node.phase) * 35 +
      Math.sin(t * 0.4 + node.phase * 0.9) * 18;
    return { x, y, radius: node.radius, phase: node.phase };
  });

  const connections: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    dist: number;
  }[] = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < CONNECTION_DISTANCE) {
        connections.push({
          x1: positions[i].x,
          y1: positions[i].y,
          x2: positions[j].x,
          y2: positions[j].y,
          dist,
        });
      }
    }
  }

  return (
    <svg
      width={1920}
      height={1080}
      style={{ position: "absolute", top: 0, left: 0, opacity }}
    >
      {connections.map((conn, idx) => {
        const baseOpacity = (1 - conn.dist / CONNECTION_DISTANCE) * 0.3;
        const pulse =
          0.5 +
          0.5 *
            Math.sin(
              (frame / fps) * 2.5 + (conn.x1 + conn.y1) * 0.005
            );
        const lineOpacity = baseOpacity * (0.6 + 0.4 * pulse);
        return (
          <line
            key={`c-${idx}`}
            x1={conn.x1}
            y1={conn.y1}
            x2={conn.x2}
            y2={conn.y2}
            stroke="#00d4ff"
            strokeWidth={0.8}
            opacity={lineOpacity}
          />
        );
      })}
      {positions.map((pos, idx) => {
        const pulse = 0.6 + 0.4 * Math.sin((frame / fps) * 3 + pos.phase);
        const glowRadius = pos.radius * (2 + pulse);
        return (
          <g key={`n-${idx}`}>
            <circle
              cx={pos.x}
              cy={pos.y}
              r={glowRadius}
              fill="rgba(0, 212, 255, 0.08)"
            />
            <circle
              cx={pos.x}
              cy={pos.y}
              r={pos.radius * pulse}
              fill="#00d4ff"
              opacity={0.7 + 0.3 * pulse}
            />
          </g>
        );
      })}
    </svg>
  );
};

const PillarWord: React.FC<{
  text: string;
  color: string;
  frame: number;
  fps: number;
  startFrame: number;
  compressProgress: number;
  fadeOut: number;
}> = ({ text, color, frame, fps, startFrame, compressProgress, fadeOut }) => {
  const enterProgress = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 12, stiffness: 100, mass: 0.8 },
  });

  const wordOpacity = interpolate(enterProgress, [0, 1], [0, 1]) * fadeOut;
  const enterY = interpolate(enterProgress, [0, 1], [80, 0]);

  // During compression phase, words scale down and merge toward center
  const scale = interpolate(compressProgress, [0, 1], [1, 0.4], {
    extrapolateRight: "clamp",
  });
  const compressOpacity = interpolate(compressProgress, [0, 0.6, 1], [1, 0.8, 0], {
    extrapolateRight: "clamp",
  });

  const glowPulse = 0.5 + 0.5 * Math.sin((frame / fps) * 3);
  const glowSize = 10 + glowPulse * 8;

  return (
    <div
      style={{
        opacity: wordOpacity * compressOpacity,
        transform: `translateY(${enterY}px) scale(${scale})`,
        fontSize: 72,
        fontWeight: 800,
        fontFamily: FONT_FAMILY,
        color,
        letterSpacing: -1,
        lineHeight: 1.3,
        textShadow: `0 0 ${glowSize}px ${color}66, 0 0 ${glowSize * 2}px ${color}33`,
        textAlign: "center" as const,
      }}
    >
      {text}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Scene Component
// ---------------------------------------------------------------------------
export const Scene7Closing: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Phase calculations
  const compressProgress = interpolate(frame, [60, 90], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Mesh background fades in during phase 2
  const meshOpacity = interpolate(frame, [55, 80], [0, 0.7], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Logo appearance
  const logoSpring = spring({
    frame: frame - 75,
    fps,
    config: { damping: 14, stiffness: 80, mass: 1 },
  });
  const logoOpacity = interpolate(logoSpring, [0, 1], [0, 1]);
  const logoScale = interpolate(logoSpring, [0, 1], [0.7, 1]);
  const logoY = interpolate(logoSpring, [0, 1], [30, 0]);

  // Logo glow pulse
  const logoGlowPulse = 0.6 + 0.4 * Math.sin((frame / fps) * 2.2);
  const logoGlowSize = 25 + logoGlowPulse * 20;

  // CTA / footer text fade in
  const ctaProgress = spring({
    frame: frame - 125,
    fps,
    config: { damping: 100, stiffness: 35, mass: 1 },
  });
  const ctaOpacity = interpolate(ctaProgress, [0, 1], [0, 1]);
  const ctaY = interpolate(ctaProgress, [0, 1], [20, 0]);

  // Fade to black in last 15 frames (frames 165-179)
  const fadeToBlack = interpolate(frame, [164, 179], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Vignette
  const vignetteOpacity = interpolate(frame, [0, 30], [0, 0.8], {
    extrapolateRight: "clamp",
  });

  // Radial glow behind logo - appears with logo
  const glowBgOpacity = interpolate(frame, [60, 90], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Pillar fade-out multiplier (they disappear as logo comes in)
  const pillarFade = interpolate(frame, [60, 85], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "relative",
        width: 1920,
        height: 1080,
        backgroundColor: "#0a0e1a",
        overflow: "hidden",
      }}
    >
      {/* Radial gradient glow behind logo (cyan + purple) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: [
            "radial-gradient(ellipse 800px 450px at 50% 45%, rgba(0, 212, 255, 0.12) 0%, transparent 70%)",
            "radial-gradient(ellipse 600px 350px at 50% 45%, rgba(123, 47, 190, 0.10) 0%, transparent 60%)",
          ].join(", "),
          opacity: glowBgOpacity * logoGlowPulse,
        }}
      />

      {/* Mesh network background (bookend from Scene 1) */}
      <MeshBackground frame={frame} fps={fps} opacity={meshOpacity} />

      {/* Vignette overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 50% 50%, transparent 35%, rgba(10, 14, 26, 0.9) 100%)",
          opacity: vignetteOpacity,
          pointerEvents: "none",
        }}
      />

      {/* Phase 1: Four pillars stacking vertically */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          opacity: pillarFade,
        }}
      >
        {PILLARS.map((pillar, idx) => (
          <PillarWord
            key={pillar.text}
            text={pillar.text}
            color={pillar.color}
            frame={frame}
            fps={fps}
            startFrame={idx * PILLAR_STAGGER}
            compressProgress={compressProgress}
            fadeOut={1}
          />
        ))}
      </div>

      {/* Phase 2 & 3: Logo and CTA */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* MeshWhisper logo/wordmark */}
        <div
          style={{
            opacity: logoOpacity,
            transform: `translateY(${logoY}px) scale(${logoScale})`,
            fontSize: 90,
            fontWeight: 800,
            fontFamily: FONT_FAMILY,
            color: "#ffffff",
            letterSpacing: -2,
            textShadow: [
              `0 0 ${logoGlowSize}px rgba(0, 212, 255, ${0.6 * logoGlowPulse})`,
              `0 0 ${logoGlowSize * 2}px rgba(0, 212, 255, ${0.3 * logoGlowPulse})`,
              `0 0 ${logoGlowSize * 3}px rgba(123, 47, 190, ${0.15 * logoGlowPulse})`,
            ].join(", "),
          }}
        >
          Mesh
          <span style={{ color: "#00d4ff" }}>Whisper</span>
        </div>

        {/* CTA / footer info */}
        <div
          style={{
            opacity: ctaOpacity,
            transform: `translateY(${ctaY}px)`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 18,
            marginTop: 48,
          }}
        >
          <div
            style={{
              fontSize: 28,
              fontWeight: 500,
              fontFamily: FONT_FAMILY,
              color: "rgba(255, 255, 255, 0.9)",
              letterSpacing: 2,
              textShadow: "0 0 15px rgba(0, 212, 255, 0.3)",
            }}
          >
            Open Source
            <span
              style={{
                display: "inline-block",
                margin: "0 16px",
                color: "rgba(255, 255, 255, 0.4)",
              }}
            >
              —
            </span>
            <span style={{ color: "#00d4ff" }}>
              github.com/twotwoonethree/anton
            </span>
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 400,
              fontFamily: FONT_FAMILY,
              color: "rgba(255, 255, 255, 0.55)",
              letterSpacing: 3,
              textTransform: "uppercase" as const,
            }}
          >
            MeshWhisper Foundation, Ireland
          </div>
        </div>
      </div>

      {/* Fade to black overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "#000000",
          opacity: fadeToBlack,
          pointerEvents: "none",
        }}
      />
    </div>
  );
};
