// Run in every frame before any page script. WebView2 ignores the WebRTC policy switch, so WebRTC
// is a way out the sink proxy doesn't close (docs/shell-design.md, "Egress outside fetch"). Its
// interfaces are taken off the global here. Familiar uses no WebRTC.
(() => {
  for (const name of [
    'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription',
    'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport',
    'RTCCertificate'
  ]) {
    try { delete globalThis[name]; } catch (_) { /* nothing to remove */ }
  }
})();
