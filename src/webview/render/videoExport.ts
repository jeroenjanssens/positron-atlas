/** Returns true if MediaRecorder with WebM/VP8 is available. */
export function isVideoSupported(): boolean {
  if (typeof MediaRecorder === 'undefined') return false;
  return (
    MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ||
    MediaRecorder.isTypeSupported('video/webm')
  );
}

/** Check EBML magic bytes for a valid WebM container. */
export function isValidWebM(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

export class VideoRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  /** Start recording from canvas at the given fps. */
  start(canvas: HTMLCanvasElement, fps = 30): void {
    this.chunks = [];
    this.stream = canvas.captureStream(fps);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
    this.recorder = new MediaRecorder(this.stream, { mimeType });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  /** Stop and return the recorded bytes as a base64 string. */
  stop(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) { reject(new Error('Not recording')); return; }
      this.recorder.onstop = async () => {
        const blob = new Blob(this.chunks, { type: 'video/webm' });
        const ab = await blob.arrayBuffer();
        const bytes = new Uint8Array(ab);
        // Convert to base64 in chunks to avoid stack overflow on large videos.
        let b64 = '';
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        resolve(btoa(b64));
      };
      this.recorder.stop();
      this.stream?.getTracks().forEach((t) => t.stop());
    });
  }

  get isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }
}
