import React from "react";
import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";

const CODE_LINES = [
  'import { MeshWhisper } from \'@meshwhisper/sdk\';',
  '',
  'MeshWhisper.init({',
  '  namespace: "com.myapp",',
  '  permissionModel: "mutual",',
  '  onMessage: (msg) => showChat(msg)',
  '});',
];

// Total character count for typing effect
const TOTAL_CHARS = CODE_LINES.reduce((sum, line) => sum + line.length + 1, 0); // +1 for newline

const syntaxHighlight = (line: string): React.ReactNode[] => {
  const parts: React.ReactNode[] = [];
  let remaining = line;
  let key = 0;

  const push = (text: string, color: string) => {
    parts.push(
      <span key={key++} style={{ color }}>
        {text}
      </span>
    );
  };

  // Handle import line
  if (remaining.startsWith("import")) {
    push("import", "#c792ea"); // purple - keyword
    remaining = remaining.slice(6);
    const braceOpen = remaining.indexOf("{");
    const braceClose = remaining.indexOf("}");
    if (braceOpen !== -1 && braceClose !== -1) {
      push(remaining.slice(0, braceOpen + 1), "#89ddff"); // cyan - punctuation
      push(remaining.slice(braceOpen + 1, braceClose), "#80cbc4"); // cyan - identifier
      push(remaining.slice(braceClose, braceClose + 1), "#89ddff");
      remaining = remaining.slice(braceClose + 1);
    }
    const fromIdx = remaining.indexOf("from");
    if (fromIdx !== -1) {
      push(remaining.slice(0, fromIdx), "#89ddff");
      push("from", "#c792ea"); // purple - keyword
      remaining = remaining.slice(fromIdx + 4);
    }
    // String portion
    const sqOpen = remaining.indexOf("'");
    if (sqOpen !== -1) {
      push(remaining.slice(0, sqOpen), "#eeffff");
      const sqClose = remaining.indexOf("'", sqOpen + 1);
      if (sqClose !== -1) {
        push(remaining.slice(sqOpen, sqClose + 1), "#c3e88d"); // green - string
        push(remaining.slice(sqClose + 1), "#89ddff");
      } else {
        push(remaining.slice(sqOpen), "#c3e88d");
      }
    } else {
      push(remaining, "#eeffff");
    }
    return parts;
  }

  // Handle lines with double-quoted strings and properties
  // Split by double quotes to find strings
  const dqParts = remaining.split('"');
  for (let i = 0; i < dqParts.length; i++) {
    if (i % 2 === 1) {
      // Inside quotes
      push('"' + dqParts[i] + '"', "#c3e88d"); // green - string
    } else {
      // Outside quotes - highlight keywords, properties, punctuation
      const tokens = tokenize(dqParts[i]);
      tokens.forEach((token) => {
        push(token.text, token.color);
      });
    }
  }

  return parts;
};

interface Token {
  text: string;
  color: string;
}

const tokenize = (segment: string): Token[] => {
  const tokens: Token[] = [];
  if (!segment) return tokens;

  // Simple character-by-character tokenizer
  let i = 0;
  while (i < segment.length) {
    // Skip whitespace
    if (segment[i] === " " || segment[i] === "\t") {
      let ws = "";
      while (i < segment.length && (segment[i] === " " || segment[i] === "\t")) {
        ws += segment[i];
        i++;
      }
      tokens.push({ text: ws, color: "#eeffff" });
      continue;
    }

    // Punctuation
    if ("{}().,;:".includes(segment[i])) {
      tokens.push({ text: segment[i], color: "#89ddff" });
      i++;
      continue;
    }

    // Arrow =>
    if (segment[i] === "=" && segment[i + 1] === ">") {
      tokens.push({ text: "=>", color: "#c792ea" });
      i += 2;
      continue;
    }

    // Word
    let word = "";
    while (
      i < segment.length &&
      segment[i] !== " " &&
      segment[i] !== "\t" &&
      !"{}().,;:".includes(segment[i]) &&
      !(segment[i] === "=" && segment[i + 1] === ">")
    ) {
      word += segment[i];
      i++;
    }

    if (!word) {
      // Safety: skip unexpected char
      tokens.push({ text: segment[i] || "", color: "#eeffff" });
      i++;
      continue;
    }

    // Classify the word
    if (word === "MeshWhisper") {
      tokens.push({ text: word, color: "#82aaff" }); // blue - class
    } else if (word === "init" || word === "showChat") {
      tokens.push({ text: word, color: "#82aaff" }); // blue - function
    } else if (["namespace", "permissionModel", "onMessage"].includes(word)) {
      tokens.push({ text: word, color: "#eeffff" }); // white - property
    } else if (word === "msg") {
      tokens.push({ text: word, color: "#eeffff" }); // white - param
    } else if (word === "const" || word === "let" || word === "var") {
      tokens.push({ text: word, color: "#c792ea" }); // purple - keyword
    } else {
      tokens.push({ text: word, color: "#eeffff" }); // white - default
    }
  }

  return tokens;
};

// Build the full code string with newlines
const FULL_CODE = CODE_LINES.join("\n");

const getTypedCode = (frame: number): string => {
  // Typing starts at frame 60, ends at frame 180
  // 120 frames to type all characters
  const typingProgress = interpolate(frame, [60, 175], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const charCount = Math.floor(typingProgress * FULL_CODE.length);
  return FULL_CODE.slice(0, charCount);
};

const HighlightedCode: React.FC<{ code: string }> = ({ code }) => {
  const lines = code.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} style={{ minHeight: "1.6em", lineHeight: "1.6em" }}>
          <span style={{ color: "#5c6370", marginRight: 20, userSelect: "none", display: "inline-block", width: 24, textAlign: "right" }}>
            {i + 1}
          </span>
          {syntaxHighlight(line)}
        </div>
      ))}
    </>
  );
};

// SVG Icons
const CloudXIcon: React.FC = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#82aaff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    <line x1="14" y1="11" x2="10" y2="17" />
    <line x1="10" y1="11" x2="14" y2="17" />
  </svg>
);

const LockIcon: React.FC = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#c3e88d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const WifiOffIcon: React.FC = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#c792ea" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
    <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
    <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
    <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
    <circle cx="12" cy="20" r="1" fill="#c792ea" />
  </svg>
);

const BADGES = [
  { label: "Zero Servers", icon: <CloudXIcon />, delay: 0 },
  { label: "End-to-End Encrypted", icon: <LockIcon />, delay: 6 },
  { label: "Works Offline", icon: <WifiOffIcon />, delay: 12 },
];

export const Scene3Solution: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // --- Title ---
  const titleOpacity = interpolate(frame, [0, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(frame, [0, 40], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // --- Code Editor ---
  const editorScale = spring({
    frame: frame - 50,
    fps,
    config: { damping: 14, stiffness: 120, mass: 0.8 },
  });
  const editorOpacity = interpolate(frame, [50, 65], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const typedCode = getTypedCode(frame);

  // Cursor blink: visible every other 15-frame cycle
  const cursorVisible = Math.floor(frame / 15) % 2 === 0 && frame >= 60 && frame < 240;

  // --- Counter (180-240) ---
  const counterOpacity = interpolate(frame, [180, 200], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const counterSpring = spring({
    frame: frame - 185,
    fps,
    config: { damping: 12, stiffness: 80, mass: 0.6 },
  });
  const lineCount = Math.round(
    interpolate(
      spring({
        frame: frame - 190,
        fps,
        config: { damping: 15, stiffness: 60, mass: 1 },
      }),
      [0, 1],
      [0, 7],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    )
  );

  // --- Phase 4: code shrinks left, badges appear right (240-359) ---
  const phase4Progress = interpolate(frame, [240, 280], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Code editor transforms
  const editorTranslateX = interpolate(phase4Progress, [0, 1], [0, -200]);
  const editorScaleFinal = interpolate(phase4Progress, [0, 1], [1, 0.72]);

  // Tagline text
  const taglineOpacity = interpolate(frame, [195, 215], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Hide tagline during phase 4
  const taglineFadeOut = interpolate(frame, [240, 260], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        width: 1920,
        height: 1080,
        backgroundColor: "#0a0e1a",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Subtle gradient background */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background:
            "radial-gradient(ellipse at 50% 30%, rgba(130, 170, 255, 0.06) 0%, transparent 70%)",
        }}
      />

      {/* Title */}
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          marginTop: 60,
          zIndex: 1,
        }}
      >
        <h1
          style={{
            fontSize: 56,
            fontWeight: 700,
            color: "#ffffff",
            margin: 0,
            letterSpacing: "-0.02em",
          }}
        >
          The{" "}
          <span
            style={{
              background: "linear-gradient(135deg, #82aaff, #c3e88d)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Solution
          </span>
        </h1>
      </div>

      {/* Code Editor + Badges Container */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          width: "100%",
          zIndex: 1,
          marginTop: -20,
        }}
      >
        {/* Code editor wrapper */}
        <div
          style={{
            opacity: editorOpacity,
            transform: `scale(${editorScale * editorScaleFinal}) translateX(${editorTranslateX}px)`,
            transformOrigin: "center center",
          }}
        >
          {/* Code Editor */}
          <div
            style={{
              backgroundColor: "#1e1e2e",
              borderRadius: 16,
              overflow: "hidden",
              width: 740,
              boxShadow:
                "0 25px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.06)",
            }}
          >
            {/* Title bar */}
            <div
              style={{
                height: 44,
                backgroundColor: "#181825",
                display: "flex",
                alignItems: "center",
                paddingLeft: 18,
                gap: 8,
                borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}
            >
              <div
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: "50%",
                  backgroundColor: "#ff5f57",
                }}
              />
              <div
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: "50%",
                  backgroundColor: "#febc2e",
                }}
              />
              <div
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: "50%",
                  backgroundColor: "#28c840",
                }}
              />
              <span
                style={{
                  marginLeft: 16,
                  color: "#5c6370",
                  fontSize: 13,
                  fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
                }}
              >
                app.ts
              </span>
            </div>

            {/* Code area */}
            <div
              style={{
                padding: "20px 24px",
                fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
                fontSize: 17,
                minHeight: 260,
                position: "relative",
              }}
            >
              <HighlightedCode code={typedCode} />
              {/* Cursor */}
              {cursorVisible && (
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 22,
                    backgroundColor: "#82aaff",
                    position: "absolute",
                    animation: "none",
                    opacity: 0.9,
                    marginLeft: 2,
                    verticalAlign: "text-bottom",
                    // Position cursor at the end of typed text
                    ...((() => {
                      const lines = typedCode.split("\n");
                      const lastLineIdx = lines.length - 1;
                      const lastLine = lines[lastLineIdx];
                      // Approximate character width for monospace at 17px
                      const charWidth = 10.2;
                      const lineNumberWidth = 44; // line number + margin
                      const left = lineNumberWidth + lastLine.length * charWidth + 24;
                      const top = 20 + lastLineIdx * 27.2; // lineHeight * index
                      return { left, top };
                    })()),
                  }}
                />
              )}
            </div>
          </div>

          {/* Counter below editor */}
          <div
            style={{
              opacity: counterOpacity * taglineFadeOut,
              transform: `translateY(${interpolate(counterSpring, [0, 1], [30, 0])}px)`,
              textAlign: "center",
              marginTop: 30,
            }}
          >
            <span
              style={{
                fontSize: 28,
                color: "#82aaff",
                fontWeight: 600,
              }}
            >
              Lines of code:{" "}
              <span
                style={{
                  fontSize: 42,
                  fontWeight: 800,
                  color: "#c3e88d",
                }}
              >
                {lineCount}
              </span>
            </span>
            <div
              style={{
                opacity: taglineOpacity,
                marginTop: 12,
              }}
            >
              <span
                style={{
                  fontSize: 24,
                  color: "rgba(255,255,255,0.7)",
                  fontWeight: 400,
                }}
              >
                That's it. Free messaging. Forever.
              </span>
            </div>
          </div>
        </div>

        {/* Feature Badges (phase 4) */}
        {frame >= 240 && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 24,
              marginLeft: 80,
            }}
          >
            {BADGES.map((badge, i) => {
              const badgeSpring = spring({
                frame: frame - 260 - badge.delay,
                fps,
                config: { damping: 12, stiffness: 100, mass: 0.7 },
              });
              const badgeOpacity = interpolate(
                frame,
                [260 + badge.delay, 275 + badge.delay],
                [0, 1],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
              );
              return (
                <div
                  key={i}
                  style={{
                    opacity: badgeOpacity,
                    transform: `translateX(${interpolate(badgeSpring, [0, 1], [60, 0])}px) scale(${interpolate(badgeSpring, [0, 1], [0.8, 1])})`,
                    display: "flex",
                    alignItems: "center",
                    gap: 18,
                    backgroundColor: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 14,
                    padding: "18px 28px",
                    minWidth: 320,
                  }}
                >
                  <div
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: 12,
                      backgroundColor: "rgba(130,170,255,0.1)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {badge.icon}
                  </div>
                  <span
                    style={{
                      fontSize: 22,
                      fontWeight: 600,
                      color: "#eeffff",
                      letterSpacing: "0.01em",
                    }}
                  >
                    {badge.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
