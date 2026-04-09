import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

// --- SVG Icon Components ---

const DeveloperIcon: React.FC<{ opacity: number }> = ({ opacity }) => (
  <svg
    width="120"
    height="160"
    viewBox="0 0 120 160"
    style={{ opacity }}
  >
    {/* Head */}
    <circle cx="60" cy="35" r="25" fill="#c0c8e0" />
    {/* Body */}
    <rect x="30" y="65" width="60" height="55" rx="10" fill="#3a4a7a" />
    {/* Arms */}
    <rect x="10" y="70" width="20" height="12" rx="6" fill="#3a4a7a" />
    <rect x="90" y="70" width="20" height="12" rx="6" fill="#3a4a7a" />
    {/* Laptop base */}
    <rect x="15" y="125" width="90" height="8" rx="3" fill="#555e7a" />
    {/* Laptop screen */}
    <rect x="25" y="95" width="70" height="32" rx="4" fill="#1a2444" stroke="#555e7a" strokeWidth="2" />
    {/* Screen glow */}
    <rect x="30" y="100" width="60" height="22" rx="2" fill="#0d3b66" />
    {/* Code lines on screen */}
    <rect x="34" y="104" width="30" height="3" rx="1" fill="#4fc3f7" opacity={0.8} />
    <rect x="34" y="110" width="20" height="3" rx="1" fill="#81c784" opacity={0.8} />
    <rect x="34" y="116" width="35" height="3" rx="1" fill="#ffb74d" opacity={0.8} />
  </svg>
);

const DollarIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="14" fill="none" stroke={color} strokeWidth="2" opacity={0.5} />
    <text
      x="16"
      y="22"
      textAnchor="middle"
      fill={color}
      fontSize="20"
      fontWeight="bold"
      fontFamily="monospace"
    >
      $
    </text>
  </svg>
);

const ProhibitionSign: React.FC<{ scale: number; opacity: number }> = ({
  scale,
  opacity,
}) => (
  <svg
    width="300"
    height="300"
    viewBox="0 0 300 300"
    style={{
      opacity,
      transform: `scale(${scale})`,
      position: "absolute",
      top: "50%",
      left: "50%",
      marginTop: -150,
      marginLeft: -150,
      pointerEvents: "none",
    }}
  >
    <circle
      cx="150"
      cy="150"
      r="130"
      fill="none"
      stroke="#ff3344"
      strokeWidth="16"
      opacity={0.85}
    />
    <line
      x1="55"
      y1="55"
      x2="245"
      y2="245"
      stroke="#ff3344"
      strokeWidth="16"
      strokeLinecap="round"
      opacity={0.85}
    />
  </svg>
);

// --- Pricing Card Component ---

interface PricingCardProps {
  name: string;
  price: string;
  accentColor: string;
  progress: number; // 0-1, spring-driven
  countUpProgress: number; // 0-1 for counting animation
  priceNumeric: number;
}

const PricingCard: React.FC<PricingCardProps> = ({
  name,
  price,
  accentColor,
  progress,
  countUpProgress,
  priceNumeric,
}) => {
  const translateY = interpolate(progress, [0, 1], [400, 0]);
  const opacity = interpolate(progress, [0, 0.3, 1], [0, 1, 1]);
  const displayPrice = Math.round(priceNumeric * countUpProgress);

  // Extract the suffix after the number (e.g., "/mo" or "/mo per 1K users")
  const match = price.match(/\$[\d,]+(.+)/);
  const suffix = match ? match[1] : "/mo";

  return (
    <div
      style={{
        transform: `translateY(${translateY}px)`,
        opacity,
        width: 340,
        padding: "30px 28px",
        borderRadius: 20,
        background: `linear-gradient(145deg, #141b30 0%, #0f1525 100%)`,
        border: `1px solid ${accentColor}33`,
        boxShadow: `0 8px 40px ${accentColor}15, 0 2px 8px rgba(0,0,0,0.4)`,
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        gap: 14,
        position: "relative" as const,
        overflow: "hidden",
      }}
    >
      {/* Accent glow at top */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)`,
        }}
      />
      <DollarIcon color={accentColor} />
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: "#e0e6f0",
          fontFamily: "'Inter', sans-serif",
          letterSpacing: "0.02em",
        }}
      >
        {name}
      </div>
      <div
        style={{
          fontSize: 38,
          fontWeight: 800,
          color: accentColor,
          fontFamily: "'Inter', monospace",
          letterSpacing: "-0.02em",
        }}
      >
        ${displayPrice}
        <span style={{ fontSize: 16, fontWeight: 400, color: "#8a94aa" }}>
          {suffix}
        </span>
      </div>
    </div>
  );
};

// --- Main Scene ---

export const Scene2Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ========== Phase 1: Title + Developer (frames 0-90) ==========

  const titleSlideIn = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 80, mass: 0.8 },
    durationInFrames: 40,
  });
  const titleX = interpolate(titleSlideIn, [0, 1], [-800, 0]);
  const titleOpacity = interpolate(titleSlideIn, [0, 1], [0, 1]);

  const devAppear = spring({
    frame: Math.max(0, frame - 20),
    fps,
    config: { damping: 12, stiffness: 60, mass: 1 },
    durationInFrames: 40,
  });
  const devOpacity = interpolate(devAppear, [0, 1], [0, 1]);
  const devScale = interpolate(devAppear, [0, 1], [0.7, 1]);

  // ========== Phase 2: Pricing Cards (frames 90-180) ==========

  const cards = [
    {
      name: "Sendbird",
      price: "$349/mo",
      priceNumeric: 349,
      accent: "#ff4455",
      delay: 0,
    },
    {
      name: "PubNub",
      price: "$98/mo per 1K users",
      priceNumeric: 98,
      accent: "#ff8833",
      delay: 15,
    },
    {
      name: "Stream",
      price: "$119/mo",
      priceNumeric: 119,
      accent: "#ffcc22",
      delay: 30,
    },
  ];

  const cardSprings = cards.map((card) => {
    const cardFrame = Math.max(0, frame - 90 - card.delay);
    return spring({
      frame: cardFrame,
      fps,
      config: { damping: 12, stiffness: 80, mass: 0.9 },
      durationInFrames: 35,
    });
  });

  const countUpProgresses = cards.map((card) => {
    const countStart = 90 + card.delay + 10;
    return interpolate(frame, [countStart, countStart + 30], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  });

  // Developer and title fade/slide up in phase 2
  const phase2Transition = interpolate(frame, [85, 110], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleMoveUp = interpolate(phase2Transition, [0, 1], [0, -60]);
  const devFadeOut = interpolate(phase2Transition, [0, 1], [1, 0]);

  // ========== Phase 3: Prohibition (frames 180-270) ==========

  const prohibSpring = spring({
    frame: Math.max(0, frame - 185),
    fps,
    config: { damping: 10, stiffness: 100, mass: 0.7 },
    durationInFrames: 30,
  });
  const prohibScale = interpolate(prohibSpring, [0, 1], [0.2, 1]);
  const prohibOpacity = interpolate(prohibSpring, [0, 1], [0, 0.95]);

  const taglineOpacity = interpolate(frame, [200, 225], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Cards dim during phase 3
  const cardsDim = interpolate(frame, [180, 210], [1, 0.35], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ========== Phase 4: Everything fades, new text (frames 270-359) ==========

  const phase4FadeOut = interpolate(frame, [270, 310], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const hopefulTextOpacity = interpolate(frame, [300, 340], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const hopefulTextScale = spring({
    frame: Math.max(0, frame - 300),
    fps,
    config: { damping: 14, stiffness: 60, mass: 1 },
    durationInFrames: 40,
  });

  const hopefulScale = interpolate(hopefulTextScale, [0, 1], [0.85, 1]);

  // Show cards only from frame 90 onwards
  const showCards = frame >= 80;
  // Show prohibition only from frame 180 onwards
  const showProhib = frame >= 180;
  // Show hopeful text only from frame 295 onwards
  const showHopeful = frame >= 295;

  return (
    <div
      style={{
        width: 1920,
        height: 1080,
        backgroundColor: "#0a0e1a",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
      }}
    >
      {/* Subtle background gradient overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 50% 30%, #131a3515 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      {/* Phase 1 & 2: Title */}
      <div
        style={{
          position: "absolute",
          top: 100 + titleMoveUp,
          left: 0,
          right: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          opacity: phase4FadeOut,
        }}
      >
        <h1
          style={{
            fontSize: 72,
            fontWeight: 800,
            color: "#e8ecf4",
            margin: 0,
            letterSpacing: "-0.03em",
            transform: `translateX(${titleX}px)`,
            opacity: titleOpacity,
            textShadow: "0 2px 20px rgba(100, 140, 255, 0.15)",
          }}
        >
          The Messaging Problem
        </h1>
      </div>

      {/* Phase 1: Developer at desk */}
      {frame < 140 && (
        <div
          style={{
            position: "absolute",
            top: 280,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            opacity: devOpacity * devFadeOut,
            transform: `scale(${devScale})`,
          }}
        >
          <DeveloperIcon opacity={1} />
          <div
            style={{
              marginTop: 20,
              fontSize: 20,
              color: "#6a7494",
              fontWeight: 500,
              letterSpacing: "0.05em",
              opacity: interpolate(frame, [30, 50], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
            }}
          >
            &quot;I just need chat in my app...&quot;
          </div>
        </div>
      )}

      {/* Phase 2 & 3: Pricing Cards */}
      {showCards && (
        <div
          style={{
            position: "absolute",
            top: 300,
            display: "flex",
            gap: 40,
            alignItems: "flex-start",
            opacity: phase4FadeOut * cardsDim,
          }}
        >
          {cards.map((card, i) => (
            <PricingCard
              key={card.name}
              name={card.name}
              price={card.price}
              priceNumeric={card.priceNumeric}
              accentColor={card.accent}
              progress={cardSprings[i]}
              countUpProgress={countUpProgresses[i]}
            />
          ))}
        </div>
      )}

      {/* Phase 3: Prohibition sign over cards */}
      {showProhib && (
        <div
          style={{
            position: "absolute",
            top: 270,
            left: 0,
            right: 0,
            height: 400,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: phase4FadeOut,
            pointerEvents: "none",
          }}
        >
          <ProhibitionSign scale={prohibScale} opacity={prohibOpacity} />
        </div>
      )}

      {/* Phase 3: Tagline */}
      {showProhib && (
        <div
          style={{
            position: "absolute",
            bottom: 160,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            opacity: taglineOpacity * phase4FadeOut,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 48,
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: "0.04em",
            }}
          >
            <span style={{ color: "#ff4455" }}>Expensive.</span>
            <span style={{ color: "#ff8833" }}>Complex.</span>
            <span style={{ color: "#ffcc22" }}>Centralized.</span>
          </div>
        </div>
      )}

      {/* Phase 4: Hopeful text */}
      {showHopeful && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: hopefulTextOpacity,
            transform: `scale(${hopefulScale})`,
          }}
        >
          <h2
            style={{
              fontSize: 68,
              fontWeight: 800,
              color: "#e8ecf4",
              margin: 0,
              letterSpacing: "-0.02em",
              textAlign: "center",
              textShadow: "0 0 40px rgba(80, 160, 255, 0.3)",
            }}
          >
            What if messaging was{" "}
            <span
              style={{
                background: "linear-gradient(90deg, #4fc3f7, #66bb6a)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              free
            </span>
            ?
          </h2>
        </div>
      )}
    </div>
  );
};
