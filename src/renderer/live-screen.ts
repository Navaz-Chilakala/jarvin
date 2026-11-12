interface LiveCommand { id: string; op: 'start' | 'frame' | 'stop'; displayId?: string; sourceId?: string }
export {};
declare global {
  interface Window {
    liveScreen: {
      onCommand(callback: (command: LiveCommand) => void): void;
      reply(id: string, result: Record<string, unknown>): void;
    };
  }
}

const streams = new Map<string, { stream: MediaStream; video: HTMLVideoElement }>();
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { alpha: false });

function stop(displayId?: string): void {
  for (const [id, item] of streams) {
    if (displayId && id !== displayId) continue;
    item.video.pause();
    item.video.srcObject = null;
    for (const track of item.stream.getTracks()) track.stop();
    streams.delete(id);
  }
  canvas.width = 0;
  canvas.height = 0;
}

async function start(displayId: string, sourceId: string): Promise<void> {
  stop(displayId);
  if (!/^screen:\d+:\d+$/.test(sourceId)) throw new Error('Invalid screen source.');
  const constraints = { audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 1920, maxHeight: 1080 } } } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The screen stream did not deliver a frame.')), 5000);
        video.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(); }, { once: true });
        stream.getVideoTracks()[0]?.addEventListener('ended', () => { clearTimeout(timeout); reject(new Error('The screen stream ended.')); }, { once: true });
      });
    }
    streams.set(displayId, { stream, video });
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (streams.get(displayId)?.stream === stream) stop(displayId); });
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}

function frame(displayId: string): { image: string; capturedAt: number } {
  const item = streams.get(displayId);
  if (!item || item.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !context) throw new Error('No live screen frame is available.');
  const { video } = item;
  const scale = Math.min(1, 1600 / video.videoWidth, 900 / video.videoHeight);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = canvas.toDataURL('image/png').split(',', 2)[1];
  return { image, capturedAt: Date.now() };
}

window.liveScreen.onCommand((command) => {
  void (async () => {
    try {
      if (command.op === 'stop') { stop(command.displayId); window.liveScreen.reply(command.id, { ok: true }); return; }
      if (!command.displayId) throw new Error('Display is required.');
      if (command.op === 'start') {
        if (!command.sourceId) throw new Error('Screen source is required.');
        await start(command.displayId, command.sourceId);
        window.liveScreen.reply(command.id, { ok: true });
      } else if (command.op === 'frame') {
        window.liveScreen.reply(command.id, { ok: true, ...frame(command.displayId) });
      }
    } catch (error) {
      window.liveScreen.reply(command.id, { ok: false, error: String((error as Error)?.message ?? error) });
    }
  })();
});
window.addEventListener('beforeunload', () => stop());
