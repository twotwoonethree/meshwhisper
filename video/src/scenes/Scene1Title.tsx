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

interface Particle {
  x: number;
  y: number;
  speed: number;
  opacity: number;
  size: number;
  delay: number;
}

// ---------------------------------------------------------------------------
// Generate mesh nodes deterministically
// ---------------------------------------------------------------------------
const NODE_COUNT = 52;
const PARTICLE_COUNT = 60;
const CONNECTION_DISTANCE = 320;

function generateNodes(seed: number): MeshNode[] {
  const rng = mulberry32(seed);
  const nodes: MeshNode[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    nodes.push({
      x: rng() * 1920,
      y: rng() * 1080,
      radius: 2 + rng() * 3,
      speedX: (rng() - 0.5) * 0.8,
      speedY: (rng() - 0.5) * 0.8,
      phase: rng() * Math.PI * 2,
    });
  }
  return nodes;
}

function generateParticles(seed: number): Particle[] {
  const rng = mulberry32(seed);
  const particles: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      x: rng() * 1920,
      y: rng() * 1080,
      speed: 0.3 + rng() * 0.7,
      opacity: 0.15 + rng() * 0.35,
      size: 1 + rng() * 2.5,
      delay: rng() * 100,
    });
  }
  return particles;
}

// Pre-compute so they stay stable across renders
const NODES = generateNodes(42);
const PARTICLES = generateParticles(137);

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const MeshBackground: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // Compute animated positions
  const positions = NODES.map((node) => {
    const t = frame / fps;
    const x =
      node.x +
      Math.sin(t * node.speedX * 2 + node.phase) * 30 +
      Math.cos(t * 0.3 + node.phase * 1.7) * 15;
    const y =
      node.y +
      Math.cos(t * node.speedY * 2 + node.phase) * 30 +
      Math.sin(t * 0.4 + node.phase * 0.9) * 15;
    return { x, y, radius: node.radius, phase: node.phase };
  });

  // Build connections between nearby nodes
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

  // Global fade-in for the mesh
  const meshOpacity = interpolate(frame, [0, 30], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <svg
      width={1920}
      height={1080}
      style={{ position: "absolute", top: 0, left: 0, opacity: meshOpacity }}
    >
      {/* Connections */}
      {connections.map((conn, idx) => {
        const baseOpacity =
          (1 - conn.dist / CONNECTION_DISTANCE) * 0.35;
        const pulse =
          0.5 +
          0.5 *
            Math.sin(
              (frame / fps) * 2.5 +
                (conn.x1 + conn.y1) * 0.005
            );
        const opacity = baseOpacity * (0.6 + 0.4 * pulse);
        return (
          <line
            key={`c-${idx}`}
            x1={conn.x1}
            y1={conn.y1}
            x2={conn.x2}
            y2={conn.y2}
            stroke="#00d4ff"
            strokeWidth={0.8}
            opacity={opacity}
          />
        );
      })}

      {/* Nodes */}
      {positions.map((pos, idx) => {
        const pulse =
          0.6 +
          0.4 * Math.sin((frame / fps) * 3 + pos.phase);
        const glowRadius = pos.radius * (2 + pulse);
        return (
          <g key={`n-${idx}`}>
            {/* Glow */}
            <circle
              cx={pos.x}
              cy={pos.y}
              r={glowRadius}
              fill="rgba(0, 212, 255, 0.08)"
            />
            {/* Core */}
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

const FloatingParticles: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const opacity = interpolate(frame, [10, 45], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      {PARTICLES.map((p, idx) => {
        const effectiveFrame = Math.max(0, frame - p.delay);
        const t = effectiveFrame / fps;
        const drift = Math.sin(t * 0.8 + p.x * 0.01) * 20;
        const yOffset = (t * p.speed * 60) % (1080 + 40);
        const y = p.y - yOffset;
        const wrappedY = y < -20 ? y + 1080 + 40 : y;
        const particleOpacity =
          p.opacity *
          (0.5 + 0.5 * Math.sin(t * 2 + p.x * 0.02));

        return (
          <div
            key={`p-${idx}`}
            style={{
              position: "absolute",
              left: p.x + drift,
              top: wrappedY,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              backgroundColor: "rgba(255, 255, 255, 0.6)",
              opacity: particleOpacity,
              boxShadow: `0 0 ${p.size * 2}px rgba(0, 212, 255, 0.3)`,
            }}
          />
        );
      })}
    </div>
  );
};

const TitleText: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // "MeshWhisper" fades in via spring
  const titleProgress = spring({
    frame: frame - 25,
    fps,
    config: { damping: 80, stiffness: 40, mass: 1.2 },
  });

  const titleOpacity = interpolate(titleProgress, [0, 1], [0, 1]);
  const titleY = interpolate(titleProgress, [0, 1], [40, 0]);
  const titleScale = interpolate(titleProgress, [0, 1], [0.9, 1]);

  // Glow intensity pulses gently
  const glowPulse =
    0.6 + 0.4 * Math.sin((frame / fps) * 2.2);
  const glowSize = 20 + glowPulse * 15;

  // Tagline fades in later
  const taglineProgress = spring({
    frame: frame - 55,
    fps,
    config: { damping: 100, stiffness: 35, mass: 1 },
  });

  const taglineOpacity = interpolate(taglineProgress, [0, 1], [0, 1]);
  const taglineY = interpolate(taglineProgress, [0, 1], [25, 0]);

  return (
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
      {/* MeshWhisper title */}
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleY}px) scale(${titleScale})`,
          fontSize: 120,
          fontWeight: 800,
          fontFamily:
            "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
          color: "#ffffff",
          letterSpacing: -2,
          textShadow: [
            `0 0 ${glowSize}px rgba(0, 212, 255, ${0.6 * glowPulse})`,
            `0 0 ${glowSize * 2}px rgba(0, 212, 255, ${0.3 * glowPulse})`,
            `0 0 ${glowSize * 4}px rgba(123, 47, 190, ${0.15 * glowPulse})`,
          ].join(", "),
        }}
      >
        Mesh
        <span style={{ color: "#00d4ff" }}>Whisper</span>
      </div>

      {/* Tagline */}
      <div
        style={{
          opacity: taglineOpacity,
          transform: `translateY(${taglineY}px)`,
          fontSize: 36,
          fontWeight: 400,
          fontFamily:
            "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
          color: "rgba(255, 255, 255, 0.85)",
          letterSpacing: 6,
          marginTop: 24,
          textTransform: "uppercase",
          textShadow: `0 0 20px rgba(0, 212, 255, 0.3)`,
        }}
      >
        Free. Secure. Serverless. Forever.
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Scene Component
// ---------------------------------------------------------------------------
export const Scene1Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Subtle vignette overlay
  const vignetteOpacity = interpolate(frame, [0, 40], [0, 0.7], {
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
      {/* Radial gradient accent behind center */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: [
            "radial-gradient(ellipse 900px 500px at 50% 50%, rgba(123, 47, 190, 0.08) 0%, transparent 70%)",
            "radial-gradient(ellipse 600px 400px at 50% 48%, rgba(0, 212, 255, 0.05) 0%, transparent 60%)",
          ].join(", "),
          opacity: interpolate(frame, [0, 50], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      />

      {/* Mesh network background */}
      <MeshBackground frame={frame} fps={fps} />

      {/* Floating particles */}
      <FloatingParticles frame={frame} fps={fps} />

      {/* Vignette overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(10, 14, 26, 0.85) 100%)",
          opacity: vignetteOpacity,
          pointerEvents: "none",
        }}
      />

      {/* Title + tagline */}
      <TitleText frame={frame} fps={fps} />
    </div>
  );
};
