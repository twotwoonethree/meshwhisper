import { Composition } from "remotion";
import { MeshWhisperVideo } from "./Video";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MeshWhisperExplainer"
        component={MeshWhisperVideo}
        durationInFrames={2700}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
