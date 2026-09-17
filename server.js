const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const { RTCPeerConnection, MediaStream, nonstandard } = require('@roamhq/wrtc');
const { RTCVideoSource } = nonstandard;

// --- Headless configuration (overridable via environment variables) ---
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const WIDTH = parseInt(process.env.WIDTH, 10) || 640;
const HEIGHT = parseInt(process.env.HEIGHT, 10) || 480;
const FPS = parseInt(process.env.FPS, 10) || 30;
const FRAME_SIZE = WIDTH * HEIGHT * 1.5; // YUV420p byte size

// Simple timestamped logger (systemd captures stdout/stderr into the journal)
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function logError(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 1. Initialize Video Source & Global Media Stream
const videoSource = new RTCVideoSource();
const videoTrack = videoSource.createTrack();
const mediaStream = new MediaStream([videoTrack]); // Wrap in stream for browser compatibility

// 2. Start rpicam-vid (headless: no preview window)
const cameraProcess = spawn('rpicam-vid', [
  '-t', '0',
  '--width', `${WIDTH}`,
  '--height', `${HEIGHT}`,
  '--framerate', `${FPS}`,
  '--codec', 'yuv420',
  '--inline',
  '--nopreview',
  '-o', '-'
]);

cameraProcess.stderr.on('data', (data) => logError(`rpicam-vid: ${data.toString().trim()}`));
cameraProcess.on('error', (err) => logError('rpicam-vid Error:', err.message));
cameraProcess.on('exit', (code, signal) => {
  logError(`rpicam-vid exited (code=${code}, signal=${signal})`);
  // In a headless service, a dead camera means the stream is useless.
  // Shut down so systemd can restart the whole unit.
  shutdown(`camera process exited (code=${code}, signal=${signal})`);
});

// 3. Fixed Fixed-Buffer Ingestion Engine (Zero Reallocations)
let frameBuffer = Buffer.allocUnsafe(FRAME_SIZE);
let bytesRead = 0;

cameraProcess.stdout.on('data', (chunk) => {
  let chunkOffset = 0;

  while (chunkOffset < chunk.length) {
    const bytesToCopy = Math.min(chunk.length - chunkOffset, FRAME_SIZE - bytesRead);
    chunk.copy(frameBuffer, bytesRead, chunkOffset, chunkOffset + bytesToCopy);

    bytesRead += bytesToCopy;
    chunkOffset += bytesToCopy;

    if (bytesRead === FRAME_SIZE) {
      // Direct pass without intermediate Array allocations
      videoSource.onFrame({
        width: WIDTH,
        height: HEIGHT,
        data: new Uint8ClampedArray(
          frameBuffer.buffer, 
          frameBuffer.byteOffset, 
          FRAME_SIZE
        )
      });

      bytesRead = 0; // Reset offset for next frame
    }
  }
});

// 4. WebSocket Signaling
wss.on('connection', (ws, req) => {
  const clientAddr = req.socket.remoteAddress;
  log(`Client connected: ${clientAddr}`);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // Explicitly add both track and MediaStream context
  pc.addTrack(videoTrack, mediaStream);

  pc.onicecandidate = (event) => {
    if (event.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
    }
  };

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'offer') {
        await pc.setRemoteDescription(data.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', answer }));
      } else if (data.type === 'candidate' && data.candidate) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (err) {
      logError('Signaling Error:', err);
    }
  });

  ws.on('close', () => {
    log(`Client disconnected: ${clientAddr}`);
    pc.close();
  });

  ws.on('error', (err) => logError('WebSocket Error:', err.message));
});

// 5. Client Interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Raspberry Pi WebRTC Stream</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #111; color: #fff; text-align: center; margin-top: 40px; }
        video { width: 100%; max-width: 640px; border: 1px solid #333; background: #000; border-radius: 8px; }
        #status { margin-top: 12px; font-size: 14px; color: #9ca3af; }
      </style>
    </head>
    <body>
      <h2>Live Pi Camera Stream</h2>
      <video id="remoteVideo" autoplay playsinline muted></video>
      <div id="status">Connecting…</div>

      <script>
        let pc, ws;

        function setStatus(text) {
          document.getElementById('status').textContent = text;
        }

        async function startStream() {
          setStatus('Connecting…');
          const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          ws = new WebSocket(\`\${wsProtocol}//\${location.host}\`);

          pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
          });

          // Correct MediaStream assignment fallback
          pc.ontrack = (event) => {
            const videoElem = document.getElementById('remoteVideo');
            if (event.streams && event.streams[0]) {
              videoElem.srcObject = event.streams[0];
            } else {
              const inboundStream = new MediaStream([event.track]);
              videoElem.srcObject = inboundStream;
            }
            videoElem.play().catch(() => {});
            setStatus('Streaming');
          };

          pc.onicecandidate = (event) => {
            if (event.candidate && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
            }
          };

          pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
              setStatus('Connection lost. Reconnecting…');
              setTimeout(startStream, 2000);
            }
          };

          ws.onopen = async () => {
            pc.addTransceiver('video', { direction: 'recvonly' });
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'offer', offer }));
          };

          ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'answer') {
              await pc.setRemoteDescription(data.answer);
            } else if (data.type === 'candidate') {
              await pc.addIceCandidate(data.candidate);
            }
          };

          ws.onclose = () => {
            setStatus('Disconnected. Reconnecting…');
            setTimeout(startStream, 2000);
          };
        }

        // Auto-start the stream as soon as the page is loaded.
        window.addEventListener('load', startStream);
      </script>
    </body>
    </html>
  `);
});

server.listen(PORT, HOST, () => {
  log(`Headless WebRTC server listening on http://${HOST}:${PORT}`);
  log(`Stream config: ${WIDTH}x${HEIGHT} @ ${FPS}fps`);
});

// --- Graceful shutdown (systemd sends SIGTERM on stop/restart) ---
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down: ${reason}`);

  try {
    if (cameraProcess && !cameraProcess.killed) cameraProcess.kill('SIGTERM');
  } catch (err) {
    logError('Failed to stop camera process:', err.message);
  }

  wss.close();
  server.close(() => {
    log('Server closed. Exiting.');
    process.exit(0);
  });

  // Force exit if graceful close hangs
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logError('Uncaught Exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logError('Unhandled Rejection:', reason);
});
