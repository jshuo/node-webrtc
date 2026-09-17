const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const { RTCPeerConnection, MediaStream, nonstandard } = require('@roamhq/wrtc');
const { RTCVideoSource } = nonstandard;

const PORT = 3000;
const WIDTH = 640;
const HEIGHT = 480;
const FPS = 30;
const FRAME_SIZE = WIDTH * HEIGHT * 1.5; // YUV420p byte size

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 1. Initialize Video Source & Global Media Stream
const videoSource = new RTCVideoSource();
const videoTrack = videoSource.createTrack();
const mediaStream = new MediaStream([videoTrack]); // Wrap in stream for browser compatibility

// 2. Start rpicam-vid
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

cameraProcess.stderr.on('data', (data) => console.error(`rpicam-vid: ${data}`));
cameraProcess.on('error', (err) => console.error('rpicam-vid Error:', err.message));

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
wss.on('connection', (ws) => {
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
      console.error('Signaling Error:', err);
    }
  });

  ws.on('close', () => {
    pc.close();
  });
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
        button { padding: 12px 24px; font-size: 16px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; }
        button:hover { background: #1d4ed8; }
      </style>
    </head>
    <body>
      <h2>Live Pi Camera Stream</h2>
      <video id="remoteVideo" autoplay playsinline muted></video><br/><br/>
      <button onclick="startStream()">Start Stream</button>

      <script>
        let pc, ws;

        async function startStream() {
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
          };

          pc.onicecandidate = (event) => {
            if (event.candidate && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
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
        }
      </script>
    </body>
    </html>
  `);
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

process.on('SIGINT', () => {
  cameraProcess.kill();
  process.exit();
});