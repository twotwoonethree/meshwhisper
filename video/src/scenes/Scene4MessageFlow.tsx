import React from "react";
import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";

// ─── Constants ───────────────────────────────────────────────────────────────

const BG = "#0a0e1a";
const GREEN = "#00e87b";
const CYAN = "#00d4ff";
const PURPLE = "#a855f7";
const GOLD = "#fbbf24";
const DIM_WHITE = "#c8d6e5";
const MUTED = "#4a5568";

const CIPHER_CHARS = "█▓▒░@#$%&*!?<>{}[]~^";
const ORIGINAL_TEXT = "Hey Bob!";

// ─── Helper: scramble text character-by-character ────────────────────────────

function scrambleText(original: string, progress: number, seed: number): string {
  const chars = original.split("");
  const scrambled = chars.map((ch, i) => {
    const threshold = i / chars.length;
    if (progress < threshold) return ch;
    // Deterministic pseudo-random based on seed + index + frame band
    const band = Math.floor(progress * 10 + seed);
    const idx = (i * 7 + band * 13) % CIPHER_CHARS.length;
    return CIPHER_CHARS[idx];
  });
  return scrambled.join("");
}

function unscrambleText(original: string, progress: number, seed: number): string {
  const chars = original.split("");
  const result = chars.map((ch, i) => {
    const threshold = i / chars.length;
    if (progress >= threshold) return ch;
    const band = Math.floor((1 - progress) * 10 + seed);
    const idx = (i * 7 + band * 13) % CIPHER_CHARS.length;
    return CIPHER_CHARS[idx];
  });
  return result.join("");
}

// ─── SVG Icons ───────────────────────────────────────────────────────────────

const LockIcon: React.FC<{ color: string; size?: number }> = ({
  color,
  size = 28,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="3" y="11" width="18" height="11" rx="2" fill={color} />
    <path
      d="M7 11V7a5 5 0 0 1 10 0v4"
      stroke={color}
      strokeWidth="2"
      fill="none"
    />
  </svg>
);

const UnlockIcon: React.FC<{ color: string; size?: number }> = ({
  color,
  size = 28,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="3" y="11" width="18" height="11" rx="2" fill={color} />
    <path
      d="M7 11V7a5 5 0 0 1 9.9-1"
      stroke={color}
      strokeWidth="2"
      fill="none"
    />
  </svg>
);

const BlindfoldIcon: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <line x1="2" y1="2" x2="22" y2="22" stroke="#ff6b6b" strokeWidth="2" />
    <path
      d="M12 5C5 5 1 12 1 12s2.5 4.5 7 6m4 1c5-1 10-7 10-7s-2-3.5-5.5-5.5"
      stroke="#8899aa"
      strokeWidth="1.5"
      fill="none"
    />
    <circle cx="12" cy="12" r="3" stroke="#8899aa" strokeWidth="1.5" fill="none" />
  </svg>
);

// ─── Phone Mockup ────────────────────────────────────────────────────────────

const PhoneMockup: React.FC<{
  x: number;
  y: number;
  label: string;
  children?: React.ReactNode;
  glowColor?: string;
  opacity?: number;
}> = ({ x, y, label, children, glowColor, opacity = 1 }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      opacity,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
    }}
  >
    <div
      style={{
        width: 160,
        height: 280,
        borderRadius: 24,
        border: "2px solid #334155",
        background: "#111827",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        boxShadow: glowColor
          ? `0 0 30px ${glowColor}44, 0 0 60px ${glowColor}22`
          : "0 4px 20px rgba(0,0,0,0.4)",
      }}
    >
      {/* Notch */}
      <div
        style={{
          width: 60,
          height: 6,
          borderRadius: 3,
          background: "#334155",
          margin: "8px auto 4px",
        }}
      />
      {/* Screen area */}
      <div
        style={{
          flex: 1,
          margin: 6,
          borderRadius: 8,
          background: "#0f172a",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          padding: 8,
          position: "relative",
        }}
      >
        {children}
      </div>
    </div>
    <span
      style={{
        marginTop: 10,
        color: DIM_WHITE,
        fontSize: 18,
        fontFamily: "monospace",
        fontWeight: 700,
      }}
    >
      {label}
    </span>
  </div>
);

// ─── Chat Bubble ─────────────────────────────────────────────────────────────

const ChatBubble: React.FC<{
  text: string;
  color?: string;
  isEncrypted?: boolean;
}> = ({ text, color = "#1e3a5f", isEncrypted }) => (
  <div
    style={{
      background: color,
      borderRadius: 12,
      padding: "8px 14px",
      maxWidth: 130,
      color: isEncrypted ? GREEN : "#ffffff",
      fontSize: isEncrypted ? 11 : 14,
      fontFamily: isEncrypted ? "monospace" : "sans-serif",
      wordBreak: "break-all",
      lineHeight: 1.4,
      boxShadow: isEncrypted ? `0 0 12px ${GREEN}44` : "none",
    }}
  >
    {text}
  </div>
);

// ─── Step Label ──────────────────────────────────────────────────────────────

const StepLabel: React.FC<{
  text: string;
  color: string;
  opacity: number;
  x?: number;
  y?: number;
}> = ({ text, color, opacity, x, y }) => (
  <div
    style={{
      position: "absolute",
      left: x ?? 0,
      bottom: y ?? 50,
      opacity,
      color,
      fontSize: 22,
      fontFamily: "monospace",
      fontWeight: 700,
      textShadow: `0 0 20px ${color}66`,
      whiteSpace: "nowrap",
    }}
  >
    {text}
  </div>
);

// ─── Packet Visualization ────────────────────────────────────────────────────

const Packet: React.FC<{
  x: number;
  y: number;
  opacity?: number;
  scale?: number;
  isChaff?: boolean;
  ttl?: number;
  showFields?: boolean;
}> = ({ x, y, opacity = 1, scale = 1, isChaff = false, ttl = 7, showFields = true }) => (
  <div
    style={{
      position: "absolute",
      left: x - 50 * scale,
      top: y - 25 * scale,
      width: 100 * scale,
      opacity,
      transform: `scale(${scale})`,
      transformOrigin: "center",
    }}
  >
    <div
      style={{
        background: isChaff ? "#1a1f35" : "#0f172a",
        border: `1.5px solid ${isChaff ? "#334155" : CYAN}`,
        borderRadius: 8,
        padding: "4px 8px",
        fontSize: 9,
        fontFamily: "monospace",
        boxShadow: isChaff ? "none" : `0 0 15px ${CYAN}33`,
      }}
    >
      {showFields && (
        <>
          <div style={{ color: CYAN }}>dest: a7f3...</div>
          <div style={{ color: DIM_WHITE }}>TTL: {ttl}</div>
          <div style={{ color: MUTED, fontSize: 8 }}>sender: [eph]</div>
        </>
      )}
      {!showFields && (
        <div
          style={{
            width: "100%",
            height: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: isChaff ? "#334155" : CYAN,
            }}
          />
        </div>
      )}
    </div>
  </div>
);

// ─── Network Node ────────────────────────────────────────────────────────────

const NetworkNode: React.FC<{
  x: number;
  y: number;
  label?: string;
  active?: boolean;
  isEndpoint?: boolean;
  endpointColor?: string;
  showBlindfold?: boolean;
}> = ({ x, y, label, active, isEndpoint, endpointColor, showBlindfold }) => (
  <div
    style={{
      position: "absolute",
      left: x - 18,
      top: y - 18,
      width: 36,
      height: 36,
      borderRadius: 18,
      background: isEndpoint
        ? `radial-gradient(circle, ${endpointColor}44, ${endpointColor}11)`
        : active
          ? `radial-gradient(circle, ${PURPLE}88, ${PURPLE}22)`
          : `radial-gradient(circle, #1e293b, #0f172a)`,
      border: `2px solid ${
        isEndpoint ? endpointColor : active ? PURPLE : "#334155"
      }`,
      boxShadow: active
        ? `0 0 20px ${PURPLE}88, 0 0 40px ${PURPLE}44`
        : isEndpoint
          ? `0 0 15px ${endpointColor}44`
          : "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      transition: "box-shadow 0.15s",
    }}
  >
    {showBlindfold && <BlindfoldIcon size={16} />}
    {label && (
      <span
        style={{
          position: "absolute",
          top: -20,
          fontSize: 11,
          color: DIM_WHITE,
          fontFamily: "monospace",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    )}
  </div>
);

// ─── Network Edge (SVG line) ─────────────────────────────────────────────────

const NetworkEdge: React.FC<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  active?: boolean;
}> = ({ x1, y1, x2, y2, active }) => (
  <line
    x1={x1}
    y1={y1}
    x2={x2}
    y2={y2}
    stroke={active ? PURPLE : "#1e293b"}
    strokeWidth={active ? 2.5 : 1}
    style={{
      filter: active ? `drop-shadow(0 0 6px ${PURPLE}88)` : "none",
    }}
  />
);

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SCENE COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export const Scene4MessageFlow: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Phase boundaries ────────────────────────────────────────────────────

  const TITLE_END = 60;
  const ENCRYPT_START = 60;
  const ENCRYPT_END = 180;
  const WRAP_START = 180;
  const WRAP_END = 300;
  const ROUTE_START = 300;
  const ROUTE_END = 500;
  const DELIVER_START = 500;
  const DELIVER_END = 620;
  const SUMMARY_START = 620;

  // ── Network topology ───────────────────────────────────────────────────

  const nodes: Array<{ x: number; y: number; label: string }> = [
    { x: 420, y: 440, label: "Alice" }, // 0 - Alice
    { x: 580, y: 340, label: "" },       // 1
    { x: 700, y: 500, label: "" },       // 2
    { x: 820, y: 360, label: "" },       // 3
    { x: 750, y: 240, label: "" },       // 4
    { x: 960, y: 280, label: "" },       // 5
    { x: 1050, y: 440, label: "" },      // 6
    { x: 1150, y: 320, label: "" },      // 7
    { x: 1300, y: 380, label: "" },      // 8
    { x: 1480, y: 440, label: "Bob" },   // 9 - Bob
  ];

  // Edges forming the mesh
  const edges: Array<[number, number]> = [
    [0, 1], [0, 2], [1, 2], [1, 3], [1, 4],
    [2, 3], [2, 6], [3, 4], [3, 5], [3, 6],
    [4, 5], [5, 7], [6, 7], [6, 8], [7, 8],
    [7, 9], [8, 9], [5, 8],
  ];

  // The path the packet follows: Alice -> 1 -> 3 -> 5 -> 7 -> Bob
  const packetPath = [0, 1, 3, 5, 7, 9];
  const hopCount = packetPath.length - 1; // 5 hops

  // ── 1. TITLE ────────────────────────────────────────────────────────────

  const titleOpacity = interpolate(
    frame,
    [0, 15, 45, TITLE_END],
    [0, 1, 1, 0],
    { extrapolateRight: "clamp" }
  );

  const titleY = interpolate(frame, [0, 15], [30, 0], {
    extrapolateRight: "clamp",
  });

  // ── 2. ENCRYPT (60-180) ─────────────────────────────────────────────────

  const encryptPhoneOpacity = interpolate(
    frame,
    [ENCRYPT_START, ENCRYPT_START + 15],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const bubbleAppear = spring({
    frame: frame - ENCRYPT_START - 10,
    fps,
    config: { damping: 12, stiffness: 100, mass: 0.8 },
  });

  const scrambleProgress = interpolate(
    frame,
    [ENCRYPT_START + 40, ENCRYPT_START + 90],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const lockAppear = spring({
    frame: frame - ENCRYPT_START - 95,
    fps,
    config: { damping: 14, stiffness: 200, mass: 0.6 },
  });

  const encryptLabelOpacity = interpolate(
    frame,
    [ENCRYPT_START + 30, ENCRYPT_START + 45, ENCRYPT_END - 15, ENCRYPT_END],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const encryptedText =
    scrambleProgress > 0
      ? scrambleText(ORIGINAL_TEXT, scrambleProgress, frame)
      : ORIGINAL_TEXT;

  // ── 3. WRAP (180-300) ───────────────────────────────────────────────────

  const wrapProgress = interpolate(
    frame,
    [WRAP_START, WRAP_START + 30],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const packetFieldsOpacity = interpolate(
    frame,
    [WRAP_START + 30, WRAP_START + 50],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const chaffSpawn = interpolate(
    frame,
    [WRAP_START + 60, WRAP_START + 80],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const wrapLabelOpacity = interpolate(
    frame,
    [WRAP_START + 20, WRAP_START + 35, WRAP_END - 15, WRAP_END],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const chaffLabelOpacity = interpolate(
    frame,
    [WRAP_START + 70, WRAP_START + 85, WRAP_END - 15, WRAP_END],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Rotating ephemeral sender hash
  const ephemeralHashes = ["9c2e...", "f1a8...", "3d7b...", "e4c0..."];
  const currentHash =
    ephemeralHashes[Math.floor(frame / 12) % ephemeralHashes.length];

  // ── 4. ROUTE (300-500) ──────────────────────────────────────────────────

  const routeOverallProgress = interpolate(
    frame,
    [ROUTE_START, ROUTE_END],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Determine which hop we're on and progress within that hop
  const continuousHop = routeOverallProgress * hopCount;
  const currentHopIndex = Math.min(Math.floor(continuousHop), hopCount - 1);
  const hopProgress = continuousHop - currentHopIndex;

  // Packet position along the path
  const fromNodeIdx = packetPath[currentHopIndex];
  const toNodeIdx = packetPath[Math.min(currentHopIndex + 1, packetPath.length - 1)];
  const fromNode = nodes[fromNodeIdx];
  const toNode = nodes[toNodeIdx];

  const packetX = interpolate(hopProgress, [0, 1], [fromNode.x, toNode.x]);
  const packetY = interpolate(hopProgress, [0, 1], [fromNode.y, toNode.y]);

  // TTL decrements with each hop
  const currentTTL = Math.max(7 - currentHopIndex, 1);

  // Which nodes have been visited (for glow effect)
  const visitedNodes = new Set<number>();
  for (let i = 0; i <= currentHopIndex; i++) {
    visitedNodes.add(packetPath[i]);
  }
  // Node currently receiving
  const receivingNode =
    hopProgress > 0.8 ? packetPath[Math.min(currentHopIndex + 1, packetPath.length - 1)] : -1;

  // Active edges (currently being traversed)
  const activeEdges = new Set<string>();
  if (frame >= ROUTE_START && frame <= ROUTE_END) {
    // Highlight the edge currently being traversed
    const edgeKey1 = `${fromNodeIdx}-${toNodeIdx}`;
    const edgeKey2 = `${toNodeIdx}-${fromNodeIdx}`;
    activeEdges.add(edgeKey1);
    activeEdges.add(edgeKey2);
    // Also highlight previously traversed edges
    for (let i = 0; i < currentHopIndex; i++) {
      const a = packetPath[i];
      const b = packetPath[i + 1];
      activeEdges.add(`${a}-${b}`);
      activeEdges.add(`${b}-${a}`);
    }
  }

  const routeLabelOpacity = interpolate(
    frame,
    [ROUTE_START + 10, ROUTE_START + 25, ROUTE_END - 20, ROUTE_END],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const networkOpacity = interpolate(
    frame,
    [ROUTE_START - 20, ROUTE_START, ROUTE_END, ROUTE_END + 20],
    [0, 1, 1, 0.15],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Chaff packets in route phase — they disperse into different paths
  const chaffRouteOpacity = interpolate(
    frame,
    [ROUTE_START, ROUTE_START + 30, ROUTE_START + 120, ROUTE_START + 150],
    [0.7, 0.7, 0.3, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const chaff1Progress = interpolate(
    frame,
    [ROUTE_START, ROUTE_START + 150],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Chaff paths diverge
  const chaff1X = interpolate(chaff1Progress, [0, 0.5, 1], [420, 700, 1050]);
  const chaff1Y = interpolate(chaff1Progress, [0, 0.5, 1], [440, 500, 440]);
  const chaff2X = interpolate(chaff1Progress, [0, 0.5, 1], [420, 750, 960]);
  const chaff2Y = interpolate(chaff1Progress, [0, 0.5, 1], [440, 240, 280]);

  // ── 5. DELIVER (500-620) ────────────────────────────────────────────────

  const deliverPhoneOpacity = interpolate(
    frame,
    [DELIVER_START, DELIVER_START + 15],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const unlockProgress = spring({
    frame: frame - DELIVER_START - 20,
    fps,
    config: { damping: 12, stiffness: 120, mass: 0.8 },
  });

  const decryptProgress = interpolate(
    frame,
    [DELIVER_START + 40, DELIVER_START + 90],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const deliverLabelOpacity = interpolate(
    frame,
    [DELIVER_START + 15, DELIVER_START + 30, DELIVER_END - 15, DELIVER_END],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const decryptedText =
    decryptProgress < 1
      ? unscrambleText(ORIGINAL_TEXT, decryptProgress, frame)
      : ORIGINAL_TEXT;

  const bobBubbleAppear = spring({
    frame: frame - DELIVER_START - 85,
    fps,
    config: { damping: 12, stiffness: 100, mass: 0.8 },
  });

  // ── 6. SUMMARY (620-749) ───────────────────────────────────────────────

  const summaryBgOpacity = interpolate(
    frame,
    [SUMMARY_START, SUMMARY_START + 20],
    [0, 0.12],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const statItems = [
    { text: "< 500ms delivery", color: GREEN, delay: 0 },
    { text: "0 servers touched", color: CYAN, delay: 15 },
    { text: "0 metadata leaked", color: PURPLE, delay: 30 },
    { text: "No one in the middle could read it", color: GOLD, delay: 45 },
  ];

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════

  return (
    <div
      style={{
        width: 1920,
        height: 1080,
        background: BG,
        position: "relative",
        overflow: "hidden",
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
      }}
    >
      {/* ── Subtle grid background ──────────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(100,120,180,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(100,120,180,0.03) 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
        }}
      />

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 1. TITLE                                                      */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {frame < TITLE_END + 10 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: titleOpacity,
            transform: `translateY(${titleY}px)`,
          }}
        >
          <h1
            style={{
              fontSize: 72,
              fontWeight: 800,
              color: "#ffffff",
              textAlign: "center",
              letterSpacing: -1,
              textShadow: `0 0 40px ${PURPLE}66, 0 0 80px ${CYAN}33`,
              margin: 0,
            }}
          >
            How a Message Travels
          </h1>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 2. ENCRYPT PHASE                                              */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {frame >= ENCRYPT_START && frame < WRAP_END + 20 && (
        <PhoneMockup
          x={120}
          y={300}
          label="Alice"
          glowColor={GREEN}
          opacity={encryptPhoneOpacity}
        >
          <div style={{ transform: `scale(${bubbleAppear})` }}>
            <ChatBubble
              text={encryptedText}
              isEncrypted={scrambleProgress > 0.1}
              color={scrambleProgress > 0.1 ? "#0a2a1a" : "#1e3a5f"}
            />
          </div>
          {lockAppear > 0.05 && (
            <div
              style={{
                marginTop: 8,
                transform: `scale(${lockAppear})`,
                opacity: lockAppear,
              }}
            >
              <LockIcon color={GREEN} size={24} />
            </div>
          )}
        </PhoneMockup>
      )}

      {/* Encrypt step label */}
      {frame >= ENCRYPT_START && frame < ENCRYPT_END && (
        <StepLabel
          text='Step 1: Encrypt with unique one-time key'
          color={GREEN}
          opacity={encryptLabelOpacity}
          x={120}
          y={80}
        />
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 3. WRAP PHASE                                                 */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {frame >= WRAP_START && frame < ROUTE_START + 30 && (
        <>
          {/* Main packet forming */}
          <div
            style={{
              position: "absolute",
              left: 380,
              top: 400,
              opacity: wrapProgress,
              transform: `scale(${0.5 + wrapProgress * 0.5})`,
            }}
          >
            <div
              style={{
                background: "#0f172a",
                border: `2px solid ${CYAN}`,
                borderRadius: 12,
                padding: "12px 18px",
                minWidth: 180,
                boxShadow: `0 0 25px ${CYAN}33, inset 0 0 15px ${CYAN}11`,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontFamily: "monospace",
                  opacity: packetFieldsOpacity,
                }}
              >
                <div style={{ color: CYAN, marginBottom: 4 }}>
                  dest: a7f3e2b1
                </div>
                <div style={{ color: DIM_WHITE, marginBottom: 4 }}>TTL: 7</div>
                <div style={{ color: MUTED }}>sender: {currentHash}</div>
              </div>
              {/* Encrypted payload indicator */}
              <div
                style={{
                  marginTop: 8,
                  padding: "4px 8px",
                  background: `${GREEN}11`,
                  border: `1px solid ${GREEN}44`,
                  borderRadius: 6,
                  fontSize: 10,
                  fontFamily: "monospace",
                  color: GREEN,
                  textAlign: "center",
                  opacity: packetFieldsOpacity,
                }}
              >
                [encrypted payload]
              </div>
            </div>
          </div>

          {/* Chaff packets */}
          {chaffSpawn > 0 && (
            <>
              <div
                style={{
                  position: "absolute",
                  left: 370,
                  top: 310,
                  opacity: chaffSpawn * 0.6,
                  transform: `scale(${0.7 * chaffSpawn})`,
                }}
              >
                <div
                  style={{
                    background: "#111827",
                    border: "1.5px solid #334155",
                    borderRadius: 10,
                    padding: "10px 16px",
                    minWidth: 160,
                  }}
                >
                  <div style={{ fontSize: 12, fontFamily: "monospace" }}>
                    <div style={{ color: CYAN, opacity: 0.5 }}>dest: c9d1...</div>
                    <div style={{ color: DIM_WHITE, opacity: 0.5 }}>TTL: 7</div>
                    <div style={{ color: MUTED, opacity: 0.5, fontSize: 10 }}>
                      sender: [eph]
                    </div>
                  </div>
                </div>
              </div>
              <div
                style={{
                  position: "absolute",
                  left: 400,
                  top: 530,
                  opacity: chaffSpawn * 0.5,
                  transform: `scale(${0.65 * chaffSpawn})`,
                }}
              >
                <div
                  style={{
                    background: "#111827",
                    border: "1.5px solid #334155",
                    borderRadius: 10,
                    padding: "10px 16px",
                    minWidth: 160,
                  }}
                >
                  <div style={{ fontSize: 12, fontFamily: "monospace" }}>
                    <div style={{ color: CYAN, opacity: 0.5 }}>dest: 7b2e...</div>
                    <div style={{ color: DIM_WHITE, opacity: 0.5 }}>TTL: 7</div>
                    <div style={{ color: MUTED, opacity: 0.5, fontSize: 10 }}>
                      sender: [eph]
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Wrap label */}
          <StepLabel
            text="Step 2: Address with rotating hash"
            color={CYAN}
            opacity={wrapLabelOpacity}
            x={120}
            y={80}
          />

          {/* Chaff label */}
          {chaffSpawn > 0 && (
            <div
              style={{
                position: "absolute",
                left: 600,
                bottom: 120,
                opacity: chaffLabelOpacity,
                color: MUTED,
                fontSize: 18,
                fontFamily: "monospace",
                fontStyle: "italic",
              }}
            >
              + fake traffic to hide the real one
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 4. ROUTE PHASE — Mesh Network                                 */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {frame >= ROUTE_START - 20 && frame < DELIVER_END + 20 && (
        <div style={{ position: "absolute", inset: 0, opacity: networkOpacity }}>
          {/* SVG layer for edges */}
          <svg
            width={1920}
            height={1080}
            style={{ position: "absolute", inset: 0 }}
          >
            {edges.map(([a, b], i) => {
              const edgeKey = `${a}-${b}`;
              const isActive = activeEdges.has(edgeKey);
              return (
                <NetworkEdge
                  key={i}
                  x1={nodes[a].x}
                  y1={nodes[a].y}
                  x2={nodes[b].x}
                  y2={nodes[b].y}
                  active={isActive && frame >= ROUTE_START}
                />
              );
            })}
          </svg>

          {/* Nodes */}
          {nodes.map((node, i) => {
            const isAlice = i === 0;
            const isBob = i === 9;
            const isOnPath =
              packetPath.includes(i) && !isAlice && !isBob;
            const isActive =
              frame >= ROUTE_START &&
              (visitedNodes.has(i) || receivingNode === i);
            const isReceiving = receivingNode === i;

            return (
              <NetworkNode
                key={i}
                x={node.x}
                y={node.y}
                label={node.label}
                active={isActive && !isAlice && !isBob}
                isEndpoint={isAlice || isBob}
                endpointColor={isAlice ? GREEN : GOLD}
                showBlindfold={
                  isOnPath &&
                  frame >= ROUTE_START + 30 &&
                  !isReceiving
                }
              />
            );
          })}

          {/* Traveling packet */}
          {frame >= ROUTE_START && frame <= ROUTE_END && (
            <Packet
              x={packetX}
              y={packetY}
              ttl={currentTTL}
              scale={0.9}
              showFields={true}
            />
          )}

          {/* Chaff packets dispersing */}
          {chaffRouteOpacity > 0 && (
            <>
              <Packet
                x={chaff1X}
                y={chaff1Y}
                opacity={chaffRouteOpacity}
                isChaff
                scale={0.7}
                showFields={false}
              />
              <Packet
                x={chaff2X}
                y={chaff2Y}
                opacity={chaffRouteOpacity * 0.8}
                isChaff
                scale={0.65}
                showFields={false}
              />
            </>
          )}
        </div>
      )}

      {/* Route label */}
      {frame >= ROUTE_START && frame <= ROUTE_END && (
        <StepLabel
          text="Step 3: Route through the social graph"
          color={PURPLE}
          opacity={routeLabelOpacity}
          x={120}
          y={80}
        />
      )}

      {/* TTL indicator during routing */}
      {frame >= ROUTE_START + 20 && frame <= ROUTE_END - 20 && (
        <div
          style={{
            position: "absolute",
            right: 120,
            top: 100,
            opacity: routeLabelOpacity,
          }}
        >
          <div
            style={{
              background: "#111827",
              border: `1px solid ${PURPLE}44`,
              borderRadius: 10,
              padding: "12px 20px",
              fontFamily: "monospace",
              fontSize: 16,
            }}
          >
            <div style={{ color: MUTED, marginBottom: 6 }}>Current hop:</div>
            <div style={{ color: PURPLE, fontSize: 28, fontWeight: 700 }}>
              {currentHopIndex + 1} / {hopCount}
            </div>
            <div style={{ color: MUTED, marginTop: 8 }}>TTL remaining:</div>
            <div style={{ color: CYAN, fontSize: 24, fontWeight: 700 }}>
              {currentTTL}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 5. DELIVER PHASE                                              */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {frame >= DELIVER_START && frame < SUMMARY_START + 10 && (
        <PhoneMockup
          x={1620}
          y={300}
          label="Bob"
          glowColor={GOLD}
          opacity={deliverPhoneOpacity}
        >
          {/* Unlock animation */}
          {unlockProgress > 0.05 && decryptProgress < 1 && (
            <div
              style={{
                marginBottom: 8,
                transform: `scale(${unlockProgress})`,
                opacity: unlockProgress,
              }}
            >
              <UnlockIcon color={GOLD} size={24} />
            </div>
          )}
          {/* Decrypting / decrypted text */}
          {decryptProgress > 0 && decryptProgress < 1 && (
            <ChatBubble
              text={decryptedText}
              isEncrypted={true}
              color="#0a2a1a"
            />
          )}
          {/* Final decrypted bubble */}
          {bobBubbleAppear > 0.05 && (
            <div style={{ transform: `scale(${bobBubbleAppear})` }}>
              <ChatBubble text="Hey Bob!" color="#1e3a5f" />
            </div>
          )}
        </PhoneMockup>
      )}

      {/* Deliver label */}
      {frame >= DELIVER_START && frame < DELIVER_END && (
        <StepLabel
          text="Step 4: Decrypt at destination"
          color={GOLD}
          opacity={deliverLabelOpacity}
          x={120}
          y={80}
        />
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 6. SUMMARY                                                    */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {frame >= SUMMARY_START && (
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
          {/* Faded path in background */}
          <svg
            width={1920}
            height={1080}
            style={{
              position: "absolute",
              inset: 0,
              opacity: summaryBgOpacity,
            }}
          >
            {packetPath.map((nodeIdx, i) => {
              if (i === 0) return null;
              const prev = packetPath[i - 1];
              return (
                <line
                  key={i}
                  x1={nodes[prev].x}
                  y1={nodes[prev].y}
                  x2={nodes[nodeIdx].x}
                  y2={nodes[nodeIdx].y}
                  stroke={PURPLE}
                  strokeWidth={3}
                  strokeDasharray="8 4"
                />
              );
            })}
            {packetPath.map((nodeIdx, i) => (
              <circle
                key={`node-${i}`}
                cx={nodes[nodeIdx].x}
                cy={nodes[nodeIdx].y}
                r={8}
                fill={
                  i === 0
                    ? GREEN
                    : i === packetPath.length - 1
                      ? GOLD
                      : PURPLE
                }
                opacity={0.6}
              />
            ))}
          </svg>

          {/* Stats */}
          <div
            style={{
              position: "relative",
              zIndex: 2,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 28,
            }}
          >
            {statItems.map((item, i) => {
              const itemOpacity = interpolate(
                frame,
                [
                  SUMMARY_START + item.delay,
                  SUMMARY_START + item.delay + 20,
                ],
                [0, 1],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
              );

              const itemY = interpolate(
                frame,
                [
                  SUMMARY_START + item.delay,
                  SUMMARY_START + item.delay + 20,
                ],
                [25, 0],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
              );

              return (
                <div
                  key={i}
                  style={{
                    opacity: itemOpacity,
                    transform: `translateY(${itemY}px)`,
                    fontSize: 36,
                    fontWeight: 700,
                    color: item.color,
                    fontFamily: "monospace",
                    textShadow: `0 0 30px ${item.color}44`,
                    textAlign: "center",
                  }}
                >
                  {item.text}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
