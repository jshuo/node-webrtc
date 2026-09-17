const { RTCPeerConnection } = require('@roamhq/wrtc');

async function runTest() {
  console.log('Initializing Peer Connections...');

  // 1. Create two local peer connections
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();

  // 2. Exchange ICE candidates between peers
  pc1.onicecandidate = (event) => {
    if (event.candidate) pc2.addIceCandidate(event.candidate);
  };
  pc2.onicecandidate = (event) => {
    if (event.candidate) pc1.addIceCandidate(event.candidate);
  };

  // 3. Set up receiver data channel event on Peer 2
  pc2.ondatachannel = (event) => {
    const receiveChannel = event.channel;
    receiveChannel.onmessage = (e) => {
      console.log(' SUCCESS: Received message on Peer 2 ->', e.data);
      cleanup();
    };
  };

  // 4. Create data channel on Peer 1
  const sendChannel = pc1.createDataChannel('testChannel');
  sendChannel.onopen = () => {
    console.log(' Data channel opened. Sending test payload...');
    sendChannel.send('Hello from Raspberry Pi WebRTC!');
  };

  // 5. Negotiate connection (Offer / Answer exchange)
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(offer);

  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  await pc1.setRemoteDescription(answer);

  function cleanup() {
    pc1.close();
    pc2.close();
    console.log(' Test complete. Connections closed cleanly.');
    process.exit(0);
  }
}

runTest().catch((err) => {
  console.error(' WebRTC Error:', err);
  process.exit(1);
});
