import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

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
// Types & constants
// ---------------------------------------------------------------------------
interface AppNode {
  id: string;
  label: string;
  x: number;
  y: number;
  color: string;
  icon: string; // emoji stand-in
  appearFrame: number;
  phase: number; // for sine drift
}

const FONT =
  "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const MONO =
  "'JetBrains Mono', 'Fira Code', 'Consolas', monospace";

const COLORS = {
  bg: "#0a0e1a",
  cyan: "#00d4ff",
  purple: "#7b2fbe",
  green: "#00e676",
  orange: "#ff9100",
  pink: "#ff4081",
  yellow: "#ffd600",
  blue: "#448aff",
  teal: "#1de9b6",
  red: "#ff5252",
};

// ---------------------------------------------------------------------------
// Node definitions — positions tuned for 1920x1080, organic layout
// ---------------------------------------------------------------------------
const rng = mulberry32(777);

const APP_NODES: AppNode[] = [
  // Initial 3 nodes (visible from frame 0)
  {
    id: "chat",
    label: "Chat App",
    x: 520,
    y: 400,
    color: COLORS.cyan,
    icon: "\u{1F4AC}",
    appearFrame: 0,
    phase: rng() * Math.PI * 2,
  },
  {
    id: "notes",
    label: "Notes App",
    x: 960,
    y: 300,
    color: COLORS.purple,
    icon: "\u{1F4DD}",
    appearFrame: 0,
    phase: rng() * Math.PI * 2,
  },
  {
    id: "wallet",
    label: "Crypto Wallet",
    x: 1380,
    y: 420,
    color: COLORS.green,
    icon: "\u{1F4B0}",
    appearFrame: 0,
    phase: rng() * Math.PI * 2,
  },
  // Wave 1 — appear one at a time
  {
    id: "fitness",
    label: "Fitness App",
    x: 380,
    y: 650,
    color: COLORS.orange,
    icon: "\u{1F3CB}",
    appearFrame: 80,
    phase: rng() * Math.PI * 2,
  },
  {
    id: "marketplace",
    label: "Marketplace",
    x: 1100,
    y: 620,
    color: COLORS.pink,
    icon: "\u{1F6D2}",
    appearFrame: 120,
    phase: rng() * Math.PI * 2,
  },
  {
    id: "gamechat",
    label: "Game Chat",
    x: 750,
    y: 700,
    color: COLORS.yellow,
    icon: "\u{1F3AE}",
    appearFrame: 160,
    phase: rng() * Math.PI * 2,
  },
  // Wave 2 — appear together at frame 200
  {
    id: "dating",
    label: "Dating App",
    x: 1500,
    y: 280,
    color: COLORS.red,
    icon: "\u{2764}",
    appearFrame: 200,
    phase: rng() * Math.PI * 2,
  },
  {
    id: "teamtool",
    label: "Team Tool",
    x: 1520,
    y: 680,
    color: COLORS.blue,
    icon: "\u{1F465}",
    appearFrame: 200,
    phase: rng() * Math.PI * 2,
  },
  {
    id: "sports",
    label: "Sports App",
    x: 280,
    y: 280,
    color: COLORS.teal,
    icon: "\u{26BD}",
    appearFrame: 200,
    phase: rng() * Math.PI * 2,
  },
];

// Connection distance for mesh lines
const CONNECTION_DIST = 620;

// ---------------------------------------------------------------------------
// Relay path for cross-app visualization (frames 200-320)
// fitness -> gamechat -> marketplace -> notes -> wallet (back to another fitness user proxy)
// We'll use a subset of nodes to show cross-app relay
// ---------------------------------------------------------------------------
const RELAY_PATH_IDS = [
  "fitness",
  "gamechat",
  "marketplace",
  "notes",
  "wallet",
];

// ---------------------------------------------------------------------------
// Helper: animated node position with sine drift
// ---------------------------------------------------------------------------
function getNodePos(node: AppNode, frame: number, fps: number) {
  const t = frame / fps;
  const dx = Math.sin(t * 0.7 + node.phase) * 12 + Math.cos(t * 0.4 + node.phase * 1.3) * 8;
  const dy = Math.cos(t * 0.6 + node.phase) * 10 + Math.sin(t * 0.5 + node.phase * 0.7) * 6;
  return { x: node.x + dx, y: node.y + dy };
}

// ---------------------------------------------------------------------------
// Helper: lerp between two points by t [0,1]
// ---------------------------------------------------------------------------
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Phase 1: Title "Every App Makes It Stronger" */
const TitleOverlay: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const fadeIn = interpolate(frame, [0, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(frame, [50, 70], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = Math.min(fadeIn, fadeOut);

  const s = spring({
    frame,
    fps,
    config: { damping: 80, stiffness: 40, mass: 1 },
  });
  const y = interpolate(s, [0, 1], [30, 0]);
  const scale = interpolate(s, [0, 1], [0.92, 1]);

  if (opacity <= 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity,
        transform: `translateY(${y}px) scale(${scale})`,
        zIndex: 20,
      }}
    >
      <div
        style={{
          fontSize: 72,
          fontWeight: 800,
          fontFamily: FONT,
          color: "#fff",
          textShadow: `0 0 30px rgba(0, 212, 255, 0.5), 0 0 60px rgba(123, 47, 190, 0.2)`,
          textAlign: "center",
          letterSpacing: -1,
        }}
      >
        Every App Makes It{" "}
        <span style={{ color: COLORS.cyan }}>Stronger</span>
      </div>
    </div>
  );
};

/** Mesh network: nodes + connections */
const MeshNetwork: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // Compute visible nodes and their animated positions
  const visibleNodes: (AppNode & { pos: { x: number; y: number }; scale: number })[] = [];

  for (const node of APP_NODES) {
    if (frame < node.appearFrame) continue;

    const localFrame = frame - node.appearFrame;
    const s = spring({
      frame: localFrame,
      fps,
      config: { damping: 14, stiffness: 120, mass: 0.8 },
    });

    const pos = getNodePos(node, frame, fps);
    visibleNodes.push({ ...node, pos, scale: s });
  }

  // Build connections
  const connections: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    dist: number;
    drawProgress: number;
  }[] = [];

  for (let i = 0; i < visibleNodes.length; i++) {
    for (let j = i + 1; j < visibleNodes.length; j++) {
      const a = visibleNodes[i];
      const b = visibleNodes[j];
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < CONNECTION_DIST) {
        // Connection draws in based on the later node's appear time
        const laterAppear = Math.max(a.appearFrame, b.appearFrame);
        const drawProgress = interpolate(
          frame,
          [laterAppear + 5, laterAppear + 25],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );
        connections.push({
          x1: a.pos.x,
          y1: a.pos.y,
          x2: b.pos.x,
          y2: b.pos.y,
          dist,
          drawProgress,
        });
      }
    }
  }

  // Global mesh fade-in
  const meshOpacity = interpolate(frame, [0, 40], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <svg
      width={1920}
      height={1080}
      style={{ position: "absolute", top: 0, left: 0, opacity: meshOpacity }}
    >
      <defs>
        <filter id="glow">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="nodeGlow">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Connections */}
      {connections.map((conn, idx) => {
        const baseOpacity = (1 - conn.dist / CONNECTION_DIST) * 0.5;
        const pulse =
          0.5 + 0.5 * Math.sin((frame / fps) * 2.5 + (conn.x1 + conn.y1) * 0.003);
        const opacity = baseOpacity * (0.6 + 0.4 * pulse) * conn.drawProgress;

        // Draw-in: animate from x1,y1 toward x2,y2
        const endX = lerp(conn.x1, conn.x2, conn.drawProgress);
        const endY = lerp(conn.y1, conn.y2, conn.drawProgress);

        return (
          <line
            key={`conn-${idx}`}
            x1={conn.x1}
            y1={conn.y1}
            x2={endX}
            y2={endY}
            stroke={COLORS.cyan}
            strokeWidth={1}
            opacity={opacity}
          />
        );
      })}

      {/* Ripple effect for newly appearing nodes */}
      {visibleNodes.map((node) => {
        const localFrame = frame - node.appearFrame;
        if (localFrame < 0 || localFrame > 40) return null;

        const rippleProgress = interpolate(localFrame, [0, 40], [0, 1], {
          extrapolateRight: "clamp",
        });
        const rippleRadius = 20 + rippleProgress * 80;
        const rippleOpacity = (1 - rippleProgress) * 0.4;

        return (
          <circle
            key={`ripple-${node.id}`}
            cx={node.pos.x}
            cy={node.pos.y}
            r={rippleRadius}
            fill="none"
            stroke={node.color}
            strokeWidth={2}
            opacity={rippleOpacity}
          />
        );
      })}

      {/* Node circles */}
      {visibleNodes.map((node) => {
        const r = 20 * node.scale;
        const pulse = 0.85 + 0.15 * Math.sin((frame / fps) * 3 + node.phase);

        return (
          <g key={`node-${node.id}`} filter="url(#nodeGlow)">
            {/* Outer glow ring */}
            <circle
              cx={node.pos.x}
              cy={node.pos.y}
              r={r + 6}
              fill="none"
              stroke={node.color}
              strokeWidth={2}
              opacity={0.3 * pulse * node.scale}
            />
            {/* Filled background */}
            <circle
              cx={node.pos.x}
              cy={node.pos.y}
              r={r}
              fill={COLORS.bg}
              stroke={node.color}
              strokeWidth={2.5}
              opacity={node.scale}
            />
            {/* Inner bright dot */}
            <circle
              cx={node.pos.x}
              cy={node.pos.y}
              r={r * 0.35}
              fill={node.color}
              opacity={0.6 * pulse * node.scale}
            />
          </g>
        );
      })}
    </svg>
  );
};

/** App labels below each node */
const NodeLabels: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {APP_NODES.map((node) => {
        if (frame < node.appearFrame) return null;

        const localFrame = frame - node.appearFrame;
        const s = spring({
          frame: localFrame,
          fps,
          config: { damping: 14, stiffness: 120, mass: 0.8 },
        });
        const labelOpacity = interpolate(localFrame, [5, 20], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        const pos = getNodePos(node, frame, fps);

        return (
          <div
            key={`label-${node.id}`}
            style={{
              position: "absolute",
              left: pos.x,
              top: pos.y + 30 * s,
              transform: `translate(-50%, 0) scale(${s})`,
              opacity: labelOpacity,
              textAlign: "center",
              whiteSpace: "nowrap",
            }}
          >
            <div style={{ fontSize: 22, marginBottom: 2 }}>{node.icon}</div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                fontFamily: FONT,
                color: node.color,
                textShadow: `0 0 8px ${node.color}44`,
                letterSpacing: 0.5,
              }}
            >
              {node.label}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** Cross-app relay visualization (frames 200-320) */
const RelayVisualization: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  if (frame < 200 || frame > 320) return null;

  const localFrame = frame - 200;
  const totalDuration = 120; // frames for the full journey

  // Label fade in
  const labelOpacity = interpolate(localFrame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const labelFadeOut = interpolate(localFrame, [100, 120], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Build the relay path positions
  const pathNodes = RELAY_PATH_IDS.map((id) => {
    const node = APP_NODES.find((n) => n.id === id)!;
    return { ...node, pos: getNodePos(node, frame, fps) };
  });

  // Message dot progress along path (0 to pathNodes.length-1)
  const totalSegments = pathNodes.length - 1;
  const messageProgress = interpolate(
    localFrame,
    [10, totalDuration - 10],
    [0, totalSegments],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Current segment and position within segment
  const currentSegment = Math.min(
    Math.floor(messageProgress),
    totalSegments - 1
  );
  const segmentT = messageProgress - currentSegment;

  const fromNode = pathNodes[currentSegment];
  const toNode = pathNodes[Math.min(currentSegment + 1, totalSegments)];
  const dotX = lerp(fromNode.pos.x, toNode.pos.x, segmentT);
  const dotY = lerp(fromNode.pos.y, toNode.pos.y, segmentT);

  // Blindfold indicators on relay nodes (not the source or destination)
  const relayIndicators = pathNodes.slice(1, -1).map((node, idx) => {
    // Show blindfold when the dot passes through this node
    const segmentIndex = idx + 1; // segment index this node is at
    const passFrame = (segmentIndex / totalSegments) * (totalDuration - 20) + 10;
    const dist = Math.abs(localFrame - passFrame);
    const blindfoldOpacity = interpolate(dist, [0, 20], [1, 0], {
      extrapolateRight: "clamp",
      extrapolateLeft: "clamp",
    });

    return (
      <div
        key={`blind-${node.id}`}
        style={{
          position: "absolute",
          left: node.pos.x,
          top: node.pos.y - 45,
          transform: "translate(-50%, 0)",
          opacity: blindfoldOpacity,
          fontSize: 20,
          textAlign: "center",
        }}
      >
        <span role="img" aria-label="blindfolded">{"\u{1F648}"}</span>
      </div>
    );
  });

  // Glowing dot trail
  const dotPulse = 0.7 + 0.3 * Math.sin((frame / fps) * 8);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {/* Highlight the relay path */}
      <svg
        width={1920}
        height={1080}
        style={{ position: "absolute", top: 0, left: 0 }}
      >
        {pathNodes.slice(0, -1).map((node, idx) => {
          const next = pathNodes[idx + 1];
          // Segment highlight based on message progress
          const segActive = messageProgress >= idx ? 1 : 0;
          const segOpacity = interpolate(
            messageProgress,
            [idx, idx + 0.5],
            [0.1, 0.6],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );

          return (
            <line
              key={`relay-line-${idx}`}
              x1={node.pos.x}
              y1={node.pos.y}
              x2={next.pos.x}
              y2={next.pos.y}
              stroke={COLORS.cyan}
              strokeWidth={2.5}
              opacity={segOpacity * segActive}
              strokeDasharray="8 4"
            />
          );
        })}

        {/* Glowing message dot */}
        <circle
          cx={dotX}
          cy={dotY}
          r={10}
          fill={COLORS.cyan}
          opacity={0.9}
          filter="url(#glow)"
        />
        <circle
          cx={dotX}
          cy={dotY}
          r={18 * dotPulse}
          fill="none"
          stroke={COLORS.cyan}
          strokeWidth={1.5}
          opacity={0.4}
        />
        <circle
          cx={dotX}
          cy={dotY}
          r={28 * dotPulse}
          fill="none"
          stroke={COLORS.cyan}
          strokeWidth={1}
          opacity={0.15}
        />
      </svg>

      {/* Blindfold indicators on relay nodes */}
      {relayIndicators}

      {/* Label */}
      <div
        style={{
          position: "absolute",
          bottom: 100,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: labelOpacity * labelFadeOut,
        }}
      >
        <div
          style={{
            display: "inline-block",
            padding: "14px 36px",
            background: "rgba(0, 212, 255, 0.08)",
            border: "1px solid rgba(0, 212, 255, 0.2)",
            borderRadius: 12,
            fontSize: 24,
            fontWeight: 500,
            fontFamily: FONT,
            color: "rgba(255, 255, 255, 0.9)",
            textShadow: `0 0 12px rgba(0, 212, 255, 0.3)`,
          }}
        >
          Apps relay for each other —{" "}
          <span style={{ color: COLORS.cyan, fontWeight: 700 }}>
            without reading messages
          </span>
        </div>
      </div>
    </div>
  );
};

/** Density counter (frames 320-380) */
const DensityCounter: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  if (frame < 315 || frame > 385) return null;

  const localFrame = frame - 320;

  const fadeIn = interpolate(localFrame, [-5, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(localFrame, [50, 65], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = Math.min(fadeIn, fadeOut);

  // Animated counters — progress drives the count up
  const countProgress = interpolate(localFrame, [5, 50], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Eased progress for the exponential feel
  const eased = countProgress * countProgress;

  // Apps count: 6 -> 100 -> 10,000
  const appsCount = Math.round(
    countProgress < 0.5
      ? lerp(6, 100, countProgress * 2)
      : lerp(100, 10000, (countProgress - 0.5) * 2)
  );

  // Relay paths: n*(n-1)/2
  const relayPaths = Math.round((appsCount * (appsCount - 1)) / 2);

  // Delivery speed bar
  const speedWidth = interpolate(eased, [0, 1], [280, 40], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const speedLabel =
    eased < 0.3 ? "seconds" : eased < 0.7 ? "~100ms" : "milliseconds";

  const slideUp = spring({
    frame: Math.max(0, localFrame),
    fps,
    config: { damping: 60, stiffness: 50, mass: 1 },
  });
  const y = interpolate(slideUp, [0, 1], [40, 0]);

  const formatNumber = (n: number) => n.toLocaleString();

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity,
        transform: `translateY(${y}px)`,
        zIndex: 15,
      }}
    >
      <div
        style={{
          background: "rgba(10, 14, 26, 0.85)",
          border: "1px solid rgba(0, 212, 255, 0.2)",
          borderRadius: 20,
          padding: "40px 64px",
          display: "flex",
          flexDirection: "column",
          gap: 24,
          backdropFilter: "blur(12px)",
        }}
      >
        {/* Apps in mesh */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <span
            style={{
              fontSize: 20,
              fontFamily: FONT,
              color: "rgba(255,255,255,0.6)",
              fontWeight: 500,
              width: 180,
            }}
          >
            Apps in mesh:
          </span>
          <span
            style={{
              fontSize: 40,
              fontFamily: MONO,
              color: COLORS.cyan,
              fontWeight: 700,
              textShadow: `0 0 20px rgba(0, 212, 255, 0.4)`,
              minWidth: 200,
            }}
          >
            {formatNumber(appsCount)}
          </span>
        </div>

        {/* Relay paths */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <span
            style={{
              fontSize: 20,
              fontFamily: FONT,
              color: "rgba(255,255,255,0.6)",
              fontWeight: 500,
              width: 180,
            }}
          >
            Relay paths:
          </span>
          <span
            style={{
              fontSize: 40,
              fontFamily: MONO,
              color: COLORS.green,
              fontWeight: 700,
              textShadow: `0 0 20px rgba(0, 230, 118, 0.4)`,
              minWidth: 200,
            }}
          >
            {formatNumber(relayPaths)}
          </span>
        </div>

        {/* Delivery speed bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span
            style={{
              fontSize: 20,
              fontFamily: FONT,
              color: "rgba(255,255,255,0.6)",
              fontWeight: 500,
              width: 180,
            }}
          >
            Delivery speed:
          </span>
          <div
            style={{
              position: "relative",
              height: 28,
              width: 300,
              borderRadius: 14,
              overflow: "hidden",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(0, 212, 255, 0.15)",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                height: "100%",
                width: speedWidth,
                borderRadius: 14,
                background: `linear-gradient(90deg, ${COLORS.cyan}, ${COLORS.purple})`,
                boxShadow: `0 0 16px rgba(0, 212, 255, 0.4)`,
                transition: "width 0.1s ease-out",
              }}
            />
            <span
              style={{
                position: "absolute",
                top: "50%",
                left: 12,
                transform: "translateY(-50%)",
                fontSize: 13,
                fontFamily: MONO,
                fontWeight: 600,
                color: "#fff",
                textShadow: "0 1px 4px rgba(0,0,0,0.5)",
              }}
            >
              {speedLabel}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

/** Principle quote (frames 380-449) */
const PrincipleQuote: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  if (frame < 375) return null;

  const localFrame = frame - 380;

  const quoteSpring = spring({
    frame: Math.max(0, localFrame),
    fps,
    config: { damping: 60, stiffness: 40, mass: 1.1 },
  });
  const quoteOpacity = interpolate(quoteSpring, [0, 1], [0, 1]);
  const quoteY = interpolate(quoteSpring, [0, 1], [30, 0]);

  const subSpring = spring({
    frame: Math.max(0, localFrame - 15),
    fps,
    config: { damping: 80, stiffness: 35, mass: 1 },
  });
  const subOpacity = interpolate(subSpring, [0, 1], [0, 1]);
  const subY = interpolate(subSpring, [0, 1], [20, 0]);

  const glowPulse = 0.6 + 0.4 * Math.sin((frame / fps) * 2);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 20,
      }}
    >
      {/* Semi-transparent backdrop for readability */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 50% 50%, rgba(10, 14, 26, 0.8) 0%, rgba(10, 14, 26, 0.4) 100%)",
          opacity: quoteOpacity,
        }}
      />

      {/* Quote */}
      <div
        style={{
          position: "relative",
          opacity: quoteOpacity,
          transform: `translateY(${quoteY}px)`,
          textAlign: "center",
          maxWidth: 1200,
          padding: "0 60px",
        }}
      >
        <div
          style={{
            fontSize: 52,
            fontWeight: 300,
            fontFamily: FONT,
            fontStyle: "italic",
            color: "#fff",
            lineHeight: 1.4,
            textShadow: `0 0 ${20 + glowPulse * 10}px rgba(0, 212, 255, ${0.3 * glowPulse}), 0 0 ${40 + glowPulse * 20}px rgba(123, 47, 190, ${0.15 * glowPulse})`,
          }}
        >
          <span
            style={{
              color: "rgba(0, 212, 255, 0.4)",
              fontSize: 72,
              fontFamily: "Georgia, serif",
              verticalAlign: "top",
              lineHeight: 0.8,
              marginRight: 4,
            }}
          >
            {"\u201C"}
          </span>
          Relay promiscuously, connect selectively.
          <span
            style={{
              color: "rgba(0, 212, 255, 0.4)",
              fontSize: 72,
              fontFamily: "Georgia, serif",
              verticalAlign: "bottom",
              lineHeight: 0.8,
              marginLeft: 4,
            }}
          >
            {"\u201D"}
          </span>
        </div>
      </div>

      {/* Sub-text */}
      <div
        style={{
          position: "relative",
          opacity: subOpacity,
          transform: `translateY(${subY}px)`,
          marginTop: 36,
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 22,
            fontWeight: 400,
            fontFamily: MONO,
            color: "rgba(255, 255, 255, 0.55)",
            letterSpacing: 1,
          }}
        >
          Transport is{" "}
          <span style={{ color: COLORS.cyan, fontWeight: 600 }}>
            namespace-blind
          </span>
          . Sessions are{" "}
          <span style={{ color: COLORS.purple, fontWeight: 600 }}>
            namespace-isolated
          </span>
          .
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Scene Component
// ---------------------------------------------------------------------------
export const Scene5Mesh: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Subtle vignette
  const vignetteOpacity = interpolate(frame, [0, 40], [0, 0.7], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "relative",
        width: 1920,
        height: 1080,
        backgroundColor: COLORS.bg,
        overflow: "hidden",
      }}
    >
      {/* Radial gradient accent */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: [
            "radial-gradient(ellipse 1000px 600px at 50% 50%, rgba(123, 47, 190, 0.06) 0%, transparent 70%)",
            "radial-gradient(ellipse 700px 500px at 50% 48%, rgba(0, 212, 255, 0.04) 0%, transparent 60%)",
          ].join(", "),
          opacity: interpolate(frame, [0, 50], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      />

      {/* Mesh network (nodes + connections) */}
      <MeshNetwork frame={frame} fps={fps} />

      {/* Node labels */}
      <NodeLabels frame={frame} fps={fps} />

      {/* Phase 1: Title */}
      <TitleOverlay frame={frame} fps={fps} />

      {/* Phase 3: Cross-app relay */}
      <RelayVisualization frame={frame} fps={fps} />

      {/* Phase 4: Density counter */}
      <DensityCounter frame={frame} fps={fps} />

      {/* Phase 5: Principle quote */}
      <PrincipleQuote frame={frame} fps={fps} />

      {/* Vignette overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(10, 14, 26, 0.85) 100%)",
          opacity: vignetteOpacity,
          pointerEvents: "none",
          zIndex: 10,
        }}
      />
    </div>
  );
};
