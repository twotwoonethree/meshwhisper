import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

// ---------------------------------------------------------------------------
// SVG icon paths
// ---------------------------------------------------------------------------
const SHIELD_PATH =
  "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 2.18l7 3.12V11c0 4.83-3.23 9.36-7 10.46C8.23 20.36 5 15.83 5 11V6.3l7-3.12z";
const LOCK_PATH =
  "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z";
const EYE_SLASH_PATH =
  "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.804 11.804 0 001 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z";
const CLOCK_PATH =
  "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z";

// Phone SVG icon path
const PHONE_PATH =
  "M7 1C5.9 1 5 1.9 5 3v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2H7zm5 20c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm5-3H7V4h10v14z";

// ---------------------------------------------------------------------------
// Deterministic pseudo-random (mulberry32)
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
// Sub-components
// ---------------------------------------------------------------------------

// Section 1: Title with shield (frames 0-60)
const TitleSection: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const titleProgress = spring({
    frame,
    fps,
    config: { damping: 80, stiffness: 40, mass: 1.2 },
  });

  const opacity = interpolate(titleProgress, [0, 1], [0, 1]);
  const y = interpolate(titleProgress, [0, 1], [50, 0]);
  const scale = interpolate(titleProgress, [0, 1], [0.85, 1]);

  // Shield pulse
  const glowPulse = 0.5 + 0.5 * Math.sin((frame / fps) * 3);
  const shieldGlow = 15 + glowPulse * 20;

  // Fade out
  const fadeOut = interpolate(frame, [50, 65], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: opacity * fadeOut,
        transform: `translateY(${y}px) scale(${scale})`,
      }}
    >
      {/* Shield icon */}
      <svg
        width={120}
        height={120}
        viewBox="0 0 24 24"
        style={{
          marginBottom: 30,
          filter: `drop-shadow(0 0 ${shieldGlow}px rgba(0, 212, 255, ${0.6 + glowPulse * 0.4}))`,
        }}
      >
        <path d={SHIELD_PATH} fill="#00d4ff" />
        <path d={LOCK_PATH} fill="rgba(255,255,255,0.9)" transform="scale(0.5) translate(12, 14)" />
      </svg>

      <div
        style={{
          fontSize: 80,
          fontWeight: 800,
          fontFamily: "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
          color: "#ffffff",
          letterSpacing: -1,
          textShadow: `0 0 ${shieldGlow}px rgba(0, 212, 255, 0.5), 0 0 ${shieldGlow * 2}px rgba(0, 212, 255, 0.2)`,
        }}
      >
        Security By <span style={{ color: "#00d4ff" }}>Design</span>
      </div>
    </div>
  );
};

// Section 2: E2EE visualization (frames 60-160)
const E2EESection: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const localFrame = frame - 60;
  if (localFrame < 0) return null;

  const fadeIn = interpolate(localFrame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(localFrame, [85, 100], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Tunnel dash animation
  const dashOffset = (localFrame / fps) * 120;

  // Relay node positions along the tunnel
  const relayNodes = [
    { x: 660, y: 340 },
    { x: 860, y: 310 },
    { x: 1060, y: 350 },
    { x: 1260, y: 320 },
  ];

  // Eavesdropper position
  const eavesdropperY = 500;
  const eavesdropperX = 960;

  // Eavesdropper denied shake
  const shakePhase = localFrame > 30 ? Math.sin((localFrame - 30) * 0.8) * 6 : 0;
  const deniedFlash =
    localFrame > 30
      ? interpolate(
          Math.sin((localFrame - 30) * 0.4),
          [-1, 1],
          [0, 0.6],
        )
      : 0;

  // "???" text animation
  const questionOpacity = localFrame > 35 ? interpolate(localFrame, [35, 45], [0, 1], {
    extrapolateRight: "clamp",
  }) : 0;

  // Label animations
  const label1Opacity = interpolate(localFrame, [20, 35], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const label2Opacity = interpolate(localFrame, [40, 55], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: fadeIn * fadeOut,
      }}
    >
      <svg width={1920} height={1080} style={{ position: "absolute", top: 0, left: 0 }}>
        <defs>
          <linearGradient id="tunnelGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#00d4ff" stopOpacity={0.8} />
            <stop offset="50%" stopColor="#7b2fbe" stopOpacity={0.6} />
            <stop offset="100%" stopColor="#00d4ff" stopOpacity={0.8} />
          </linearGradient>
          <filter id="tunnelGlow">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Encrypted tunnel - glowing dashed line */}
        <line
          x1={380}
          y1={330}
          x2={1540}
          y2={330}
          stroke="url(#tunnelGrad)"
          strokeWidth={6}
          strokeDasharray="16 10"
          strokeDashoffset={-dashOffset}
          filter="url(#tunnelGlow)"
        />
        {/* Tunnel glow behind */}
        <line
          x1={380}
          y1={330}
          x2={1540}
          y2={330}
          stroke="url(#tunnelGrad)"
          strokeWidth={20}
          opacity={0.15}
          strokeDasharray="16 10"
          strokeDashoffset={-dashOffset}
        />

        {/* Animated data packets moving along tunnel */}
        {[0, 1, 2, 3, 4].map((i) => {
          const packetX = 380 + (((dashOffset * 2 + i * 240) % 1200));
          return (
            <rect
              key={`packet-${i}`}
              x={packetX - 10}
              y={323}
              width={20}
              height={14}
              rx={4}
              fill="#00d4ff"
              opacity={0.7 + 0.3 * Math.sin(localFrame * 0.2 + i)}
              filter="url(#tunnelGlow)"
            />
          );
        })}

        {/* Alice phone (left) */}
        <g transform="translate(280, 260)">
          <rect x={-40} y={-30} width={80} height={140} rx={12} fill="#1a2040" stroke="#00d4ff" strokeWidth={2} />
          <svg x={-20} y={10} width={40} height={40} viewBox="0 0 24 24">
            <path d={PHONE_PATH} fill="#00d4ff" />
          </svg>
          <text x={0} y={-45} textAnchor="middle" fill="#00d4ff" fontSize={22} fontWeight={700} fontFamily="'Inter', sans-serif">
            Alice
          </text>
          {/* Lock icon */}
          <svg x={-10} y={60} width={20} height={20} viewBox="0 0 24 24">
            <path d={LOCK_PATH} fill="#4ade80" />
          </svg>
        </g>

        {/* Bob phone (right) */}
        <g transform="translate(1640, 260)">
          <rect x={-40} y={-30} width={80} height={140} rx={12} fill="#1a2040" stroke="#00d4ff" strokeWidth={2} />
          <svg x={-20} y={10} width={40} height={40} viewBox="0 0 24 24">
            <path d={PHONE_PATH} fill="#00d4ff" />
          </svg>
          <text x={0} y={-45} textAnchor="middle" fill="#00d4ff" fontSize={22} fontWeight={700} fontFamily="'Inter', sans-serif">
            Bob
          </text>
          <svg x={-10} y={60} width={20} height={20} viewBox="0 0 24 24">
            <path d={LOCK_PATH} fill="#4ade80" />
          </svg>
        </g>

        {/* Relay nodes with blindfolds */}
        {relayNodes.map((node, i) => {
          const bobble = Math.sin((localFrame / fps) * 2 + i * 1.5) * 4;
          return (
            <g key={`relay-${i}`} transform={`translate(${node.x}, ${node.y + bobble})`}>
              {/* Node circle */}
              <circle r={28} fill="#1a2040" stroke="#475569" strokeWidth={2} />
              {/* X-eyes */}
              <text x={-9} y={-2} fill="#ef4444" fontSize={16} fontWeight={900} fontFamily="monospace">
                X
              </text>
              <text x={5} y={-2} fill="#ef4444" fontSize={16} fontWeight={900} fontFamily="monospace">
                X
              </text>
              {/* Blindfold bar */}
              <rect x={-20} y={-12} width={40} height={8} rx={2} fill="#374151" opacity={0.8} />
              {/* Mouth */}
              <line x1={-6} y1={12} x2={6} y2={12} stroke="#64748b" strokeWidth={2} strokeLinecap="round" />
              {/* Label */}
              <text x={0} y={50} textAnchor="middle" fill="#64748b" fontSize={13} fontFamily="'Inter', sans-serif">
                Relay {i + 1}
              </text>
            </g>
          );
        })}

        {/* Eavesdropper */}
        <g transform={`translate(${eavesdropperX + shakePhase}, ${eavesdropperY})`}>
          {/* Red flash circle */}
          <circle r={45} fill={`rgba(239, 68, 68, ${deniedFlash * 0.3})`} />
          {/* Eavesdropper eye icon */}
          <svg x={-24} y={-24} width={48} height={48} viewBox="0 0 24 24">
            <path d={EYE_SLASH_PATH} fill="#ef4444" />
          </svg>
          {/* Denied slash */}
          <circle
            r={35}
            fill="none"
            stroke="#ef4444"
            strokeWidth={3}
            opacity={0.7}
          />
          <line x1={-25} y1={25} x2={25} y2={-25} stroke="#ef4444" strokeWidth={3} opacity={0.7} />

          {/* "???" label */}
          <text
            x={0}
            y={-50}
            textAnchor="middle"
            fill="#ef4444"
            fontSize={28}
            fontWeight={800}
            fontFamily="monospace"
            opacity={questionOpacity}
          >
            ???
          </text>

          {/* Attempting dotted lines from eavesdropper to tunnel */}
          <line
            x1={0}
            y1={-40}
            x2={0}
            y2={-130}
            stroke="#ef4444"
            strokeWidth={2}
            strokeDasharray="4 6"
            opacity={0.4}
          />
        </g>
      </svg>

      {/* Labels */}
      <div
        style={{
          position: "absolute",
          bottom: 200,
          left: 0,
          right: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div
          style={{
            opacity: label1Opacity,
            fontSize: 28,
            fontWeight: 600,
            fontFamily: "'Inter', sans-serif",
            color: "#00d4ff",
            textShadow: "0 0 20px rgba(0, 212, 255, 0.4)",
          }}
        >
          End-to-end encrypted — always on, no opt-out
        </div>
        <div
          style={{
            opacity: label2Opacity,
            fontSize: 22,
            fontWeight: 400,
            fontFamily: "'Inter', sans-serif",
            color: "rgba(255, 255, 255, 0.7)",
          }}
        >
          Relays see only opaque encrypted blobs
        </div>
      </div>
    </div>
  );
};

// Section 3: Rotating hashes (frames 160-240)
const RotatingHashesSection: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const localFrame = frame - 160;
  if (localFrame < 0) return null;

  const fadeIn = interpolate(localFrame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(localFrame, [65, 80], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const hashes = ["a7f3c2d1", "9b4e1f82", "d3a70c45"];
  // Each hash visible for ~30 frames, cycle through
  const cycleFrame = localFrame % 90;
  const hashIndex = Math.min(Math.floor(cycleFrame / 30), 2);

  // Morphing effect: cross-fade between hashes
  const withinHash = cycleFrame - hashIndex * 30;
  const hashOpacity = interpolate(withinHash, [0, 8, 22, 30], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Clock rotation
  const clockRotation = (localFrame / fps) * 60; // degrees

  // Arrow indicators
  const arrowOpacity = interpolate(withinHash, [12, 18], [0, 0.6], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: fadeIn * fadeOut,
      }}
    >
      {/* Clock icon */}
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 40 }}>
        <svg
          width={60}
          height={60}
          viewBox="0 0 24 24"
          style={{
            transform: `rotate(${clockRotation}deg)`,
            filter: "drop-shadow(0 0 10px rgba(0, 212, 255, 0.5))",
          }}
        >
          <path d={CLOCK_PATH} fill="#00d4ff" />
        </svg>
        <div
          style={{
            fontSize: 32,
            fontWeight: 700,
            fontFamily: "'Inter', sans-serif",
            color: "#ffffff",
          }}
        >
          Destination Address
        </div>
      </div>

      {/* Hash display */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 30,
          height: 100,
        }}
      >
        {/* Previous hash (faded) */}
        <div
          style={{
            fontSize: 36,
            fontFamily: "monospace",
            color: "rgba(255, 255, 255, 0.15)",
            fontWeight: 600,
          }}
        >
          {hashes[(hashIndex + 2) % 3]}
        </div>

        {/* Arrow */}
        <div
          style={{
            fontSize: 36,
            color: "#00d4ff",
            opacity: arrowOpacity,
          }}
        >
          {"\u2192"}
        </div>

        {/* Current hash (glowing) */}
        <div
          style={{
            fontSize: 64,
            fontFamily: "monospace",
            fontWeight: 800,
            color: "#00d4ff",
            opacity: hashOpacity,
            textShadow:
              "0 0 20px rgba(0, 212, 255, 0.6), 0 0 40px rgba(0, 212, 255, 0.3)",
            padding: "10px 30px",
            border: "2px solid rgba(0, 212, 255, 0.3)",
            borderRadius: 12,
            backgroundColor: "rgba(0, 212, 255, 0.05)",
          }}
        >
          {hashes[hashIndex]}
        </div>

        {/* Arrow */}
        <div
          style={{
            fontSize: 36,
            color: "#00d4ff",
            opacity: arrowOpacity,
          }}
        >
          {"\u2192"}
        </div>

        {/* Next hash (faded) */}
        <div
          style={{
            fontSize: 36,
            fontFamily: "monospace",
            color: "rgba(255, 255, 255, 0.15)",
            fontWeight: 600,
          }}
        >
          {hashes[(hashIndex + 1) % 3]}
        </div>
      </div>

      {/* Label */}
      <div
        style={{
          marginTop: 50,
          fontSize: 28,
          fontWeight: 600,
          fontFamily: "'Inter', sans-serif",
          color: "#00d4ff",
          textShadow: "0 0 20px rgba(0, 212, 255, 0.4)",
        }}
      >
        Addresses rotate every hour — unlinkable across time
      </div>
    </div>
  );
};

// Section 4: Chaff traffic (frames 240-320)
const ChaffTrafficSection: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const localFrame = frame - 240;
  if (localFrame < 0) return null;

  const fadeIn = interpolate(localFrame, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(localFrame, [65, 80], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const rng = mulberry32(99);
  const packetCount = 24;
  const packets: Array<{
    baseX: number;
    baseY: number;
    isReal: boolean;
    speed: number;
    offset: number;
  }> = [];
  for (let i = 0; i < packetCount; i++) {
    packets.push({
      baseX: rng() * 1600 + 160,
      baseY: 280 + rng() * 400,
      isReal: rng() > 0.6,
      speed: 0.5 + rng() * 1.5,
      offset: rng() * 200,
    });
  }

  // Phase 1 (0-30): show colored packets (green=real, red=fake)
  // Phase 2 (30-55): transition all to neutral
  // Phase 3 (55+): all neutral
  const colorRevealPhase = interpolate(localFrame, [5, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const neutralTransition = interpolate(localFrame, [30, 50], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const labelOpacity = interpolate(localFrame, [35, 50], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: fadeIn * fadeOut,
      }}
    >
      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: 120,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 40,
          fontWeight: 700,
          fontFamily: "'Inter', sans-serif",
          color: "#ffffff",
        }}
      >
        Chaff Traffic
      </div>

      {/* Observer label */}
      <div
        style={{
          position: "absolute",
          top: 200,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 20,
          fontFamily: "'Inter', sans-serif",
          color: "rgba(255,255,255,0.5)",
          opacity: colorRevealPhase,
        }}
      >
        {neutralTransition < 0.5
          ? "An observer initially sees real (green) vs fake (red) packets..."
          : "...but from outside, they all look identical"}
      </div>

      {/* Packets */}
      <svg width={1920} height={1080} style={{ position: "absolute", top: 0, left: 0 }}>
        {packets.map((pkt, i) => {
          const x =
            ((pkt.baseX + (localFrame + pkt.offset) * pkt.speed * 3) % 1800) + 60;
          const y = pkt.baseY + Math.sin((localFrame * 0.05 + i) * 1.2) * 15;

          // Color logic
          const realColor = pkt.isReal ? "#4ade80" : "#ef4444";
          const neutralColor = "#64748b";
          // Blend from colored to neutral
          const showColor = colorRevealPhase * (1 - neutralTransition);

          // When showing color: use realColor. When neutral: use neutralColor
          const r1 = pkt.isReal ? 74 : 239;
          const g1 = pkt.isReal ? 222 : 68;
          const b1 = pkt.isReal ? 128 : 68;
          const r2 = 100;
          const g2 = 116;
          const b2 = 139;

          const r = Math.round(r1 + (r2 - r1) * neutralTransition);
          const g = Math.round(g1 + (g2 - g1) * neutralTransition);
          const b = Math.round(b1 + (b2 - b1) * neutralTransition);

          const fillColor =
            showColor > 0.01
              ? `rgb(${r}, ${g}, ${b})`
              : neutralColor;

          const glowColor =
            showColor > 0.5 ? realColor : "rgba(100, 116, 139, 0.4)";

          return (
            <g key={`pkt-${i}`}>
              {/* Glow */}
              <rect
                x={x - 18}
                y={y - 10}
                width={36}
                height={20}
                rx={6}
                fill={glowColor}
                opacity={0.15}
                filter="url(#pktBlur)"
              />
              {/* Packet */}
              <rect
                x={x - 14}
                y={y - 7}
                width={28}
                height={14}
                rx={4}
                fill={fillColor}
                opacity={0.85}
              />
            </g>
          );
        })}
        <defs>
          <filter id="pktBlur">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>
      </svg>

      {/* Label */}
      <div
        style={{
          position: "absolute",
          bottom: 180,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 28,
          fontWeight: 600,
          fontFamily: "'Inter', sans-serif",
          color: "#00d4ff",
          textShadow: "0 0 20px rgba(0, 212, 255, 0.4)",
          opacity: labelOpacity,
        }}
      >
        Constant fake traffic makes analysis impossible
      </div>
    </div>
  );
};

// Section 5: What they can't see (frames 320-380)
const CantSeeSection: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const localFrame = frame - 320;
  if (localFrame < 0) return null;

  const fadeIn = interpolate(localFrame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(localFrame, [48, 60], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const items = [
    "Message content",
    "Who sent it",
    "Who it's for",
    "Which app it belongs to",
    "Whether it's even real",
  ];

  // Each item appears every ~8 frames
  const itemDelay = 7;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: fadeIn * fadeOut,
      }}
    >
      {/* Title */}
      <div
        style={{
          fontSize: 44,
          fontWeight: 800,
          fontFamily: "'Inter', sans-serif",
          color: "#ffffff",
          marginBottom: 50,
          textShadow: "0 0 20px rgba(239, 68, 68, 0.3)",
        }}
      >
        What a relay node <span style={{ color: "#ef4444" }}>CANNOT</span> see
      </div>

      {/* Table items */}
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {items.map((item, i) => {
          const itemFrame = localFrame - (i * itemDelay + 5);
          const itemProgress = spring({
            frame: Math.max(0, itemFrame),
            fps,
            config: { damping: 60, stiffness: 120, mass: 0.8 },
          });
          const itemOpacity = itemFrame < 0 ? 0 : interpolate(itemProgress, [0, 1], [0, 1]);
          const itemX = interpolate(itemProgress, [0, 1], [-40, 0]);

          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 20,
                opacity: itemOpacity,
                transform: `translateX(${itemX}px)`,
              }}
            >
              {/* Red X icon */}
              <svg width={32} height={32} viewBox="0 0 32 32">
                <circle cx={16} cy={16} r={14} fill="rgba(239, 68, 68, 0.15)" stroke="#ef4444" strokeWidth={2} />
                <line x1={10} y1={10} x2={22} y2={22} stroke="#ef4444" strokeWidth={3} strokeLinecap="round" />
                <line x1={22} y1={10} x2={10} y2={22} stroke="#ef4444" strokeWidth={3} strokeLinecap="round" />
              </svg>

              {/* Text */}
              <div
                style={{
                  fontSize: 30,
                  fontWeight: 500,
                  fontFamily: "'Inter', sans-serif",
                  color: "rgba(255, 255, 255, 0.9)",
                }}
              >
                {item}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Section 6: Closing statement (frames 380-449)
const ClosingSection: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const localFrame = frame - 380;
  if (localFrame < 0) return null;

  const lines = [
    "No servers to hack.",
    "No metadata to subpoena.",
    "No keys to compel.",
  ];

  const lineDelay = 18;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
      }}
    >
      {lines.map((line, i) => {
        const lineFrame = localFrame - i * lineDelay;
        const lineProgress = spring({
          frame: Math.max(0, lineFrame),
          fps,
          config: { damping: 80, stiffness: 40, mass: 1 },
        });
        const lineOpacity = lineFrame < 0 ? 0 : interpolate(lineProgress, [0, 1], [0, 1]);
        const lineY = interpolate(lineProgress, [0, 1], [30, 0]);

        // Subtle glow pulse once fully visible
        const glowIntensity =
          lineOpacity > 0.9
            ? 0.3 + 0.2 * Math.sin((localFrame - i * lineDelay) * 0.1)
            : 0;

        return (
          <div
            key={i}
            style={{
              opacity: lineOpacity,
              transform: `translateY(${lineY}px)`,
              fontSize: 48,
              fontWeight: 700,
              fontFamily: "'Inter', sans-serif",
              color: "#ffffff",
              textShadow: `0 0 30px rgba(0, 212, 255, ${glowIntensity}), 0 0 60px rgba(123, 47, 190, ${glowIntensity * 0.5})`,
              letterSpacing: 1,
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Background particles (subtle, reused throughout the scene)
// ---------------------------------------------------------------------------
const rngBg = mulberry32(777);
const BG_PARTICLES: Array<{ x: number; y: number; size: number; speed: number; phase: number }> = [];
for (let i = 0; i < 40; i++) {
  BG_PARTICLES.push({
    x: rngBg() * 1920,
    y: rngBg() * 1080,
    size: 1 + rngBg() * 2,
    speed: 0.2 + rngBg() * 0.5,
    phase: rngBg() * Math.PI * 2,
  });
}

const BackgroundParticles: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const t = frame / fps;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {BG_PARTICLES.map((p, i) => {
        const x = p.x + Math.sin(t * 0.5 + p.phase) * 15;
        const y = (p.y - t * p.speed * 30 + 1080) % 1080;
        const opacity = 0.15 + 0.1 * Math.sin(t * 1.5 + p.phase);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              backgroundColor: "rgba(0, 212, 255, 0.5)",
              opacity,
            }}
          />
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Scene Component
// ---------------------------------------------------------------------------
export const Scene6Security: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div
      style={{
        position: "relative",
        width: 1920,
        height: 1080,
        backgroundColor: "#0a0e1a",
        overflow: "hidden",
        fontFamily: "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
      }}
    >
      {/* Subtle radial gradient accent */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 1000px 600px at 50% 50%, rgba(0, 212, 255, 0.04) 0%, transparent 70%)",
        }}
      />

      {/* Vignette */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 50% 50%, transparent 35%, rgba(10, 14, 26, 0.85) 100%)",
          pointerEvents: "none",
          zIndex: 10,
        }}
      />

      {/* Background particles */}
      <BackgroundParticles frame={frame} fps={fps} />

      {/* Section 1: Title (0-60) */}
      <TitleSection frame={frame} fps={fps} />

      {/* Section 2: E2EE (60-160) */}
      <E2EESection frame={frame} fps={fps} />

      {/* Section 3: Rotating hashes (160-240) */}
      <RotatingHashesSection frame={frame} fps={fps} />

      {/* Section 4: Chaff traffic (240-320) */}
      <ChaffTrafficSection frame={frame} fps={fps} />

      {/* Section 5: What they can't see (320-380) */}
      <CantSeeSection frame={frame} fps={fps} />

      {/* Section 6: Closing (380-449) */}
      <ClosingSection frame={frame} fps={fps} />
    </div>
  );
};
