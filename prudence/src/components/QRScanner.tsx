import { useEffect, useRef } from 'react';
import jsQR from 'jsqr';

interface Props {
  onResult: (data: string) => void;
  onError: () => void;
}

// Camera QR scanner. Streams the rear camera, decodes each frame with jsQR, and
// fires onResult once on the first successful decode. Calls onError if the
// camera is unavailable or permission is denied — the caller falls back to a
// paste field. The callback is held in a ref so the capture loop runs once and
// isn't restarted by parent re-renders.
export default function QRScanner({ onResult, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resultRef = useRef(onResult);
  const errorRef = useRef(onError);
  resultRef.current = onResult;
  errorRef.current = onError;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;

    function scan() {
      if (done) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState >= video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w && h) {
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, 0, 0, w, h);
            const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
            if (code?.data) {
              done = true;
              resultRef.current(code.data);
              return;
            }
          }
        }
      }
      raf = requestAnimationFrame(scan);
    }

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        scan();
      } catch {
        errorRef.current();
      }
    })();

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="relative rounded-xl overflow-hidden bg-black aspect-square">
      <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
      <canvas ref={canvasRef} className="hidden" />
      <div className="absolute inset-8 border-2 border-white/70 rounded-xl pointer-events-none" />
    </div>
  );
}
