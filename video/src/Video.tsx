import { AbsoluteFill, Sequence } from "remotion";
import { Scene1Title } from "./scenes/Scene1Title";
import { Scene2Problem } from "./scenes/Scene2Problem";
import { Scene3Solution } from "./scenes/Scene3Solution";
import { Scene4MessageFlow } from "./scenes/Scene4MessageFlow";
import { Scene5Mesh } from "./scenes/Scene5Mesh";
import { Scene6Security } from "./scenes/Scene6Security";
import { Scene7Closing } from "./scenes/Scene7Closing";

// 90-second video at 30fps = 2700 frames
// Scene breakdown:
//   Scene 1 — Title/Intro:        0–149    (5s)
//   Scene 2 — The Problem:      150–509   (12s)
//   Scene 3 — The Solution:     510–869   (12s)
//   Scene 4 — Message Flow:     870–1619  (25s)
//   Scene 5 — The Growing Mesh: 1620–2069 (15s)
//   Scene 6 — Security:        2070–2519 (15s)
//   Scene 7 — Closing/CTA:     2520–2699  (6s)

export const MeshWhisperVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0e1a" }}>
      <Sequence from={0} durationInFrames={150} name="Title">
        <Scene1Title />
      </Sequence>

      <Sequence from={150} durationInFrames={360} name="The Problem">
        <Scene2Problem />
      </Sequence>

      <Sequence from={510} durationInFrames={360} name="The Solution">
        <Scene3Solution />
      </Sequence>

      <Sequence from={870} durationInFrames={750} name="Message Flow">
        <Scene4MessageFlow />
      </Sequence>

      <Sequence from={1620} durationInFrames={450} name="The Growing Mesh">
        <Scene5Mesh />
      </Sequence>

      <Sequence from={2070} durationInFrames={450} name="Security">
        <Scene6Security />
      </Sequence>

      <Sequence from={2520} durationInFrames={180} name="Closing">
        <Scene7Closing />
      </Sequence>
    </AbsoluteFill>
  );
};
