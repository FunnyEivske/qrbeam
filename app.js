/**
 * QRBeam v3.0.0 - Wi-Fi P2P & Optical Data Transfer Engine
 * Features: Instant Wi-Fi PeerConnection via 4-digit code or 1-scan QR, with simple B&W optical QR fallback.
 */

document.addEventListener('DOMContentLoaded', () => {
  const app = new QRBeamApp();
  app.init();
});

class QRBeamApp {
  constructor() {
    this.currentView = 'home-view';
    
    // Sender State
    this.senderMode = 'file';
    this.selectedFile = null;
    this.selectedFileBuffer = null;
    this.linkText = '';
    this.senderFps = 10;
    this.senderChunkSize = 256;
    this.senderPackets = [];
    this.senderCurrentIndex = 0;
    this.senderIsPlaying = false;
    this.senderTimerId = null;
    this.senderLastFrameTime = 0;
    this.pairCode = '';

    // PeerJS P2P State
    this.peer = null;
    this.activeConnection = null;
    this.p2pConnected = false;

    // Receiver State
    this.receiverStream = null;
    this.receiverScanning = false;
    this.receiverScanAnimId = null;
    this.receiverSessionId = null;
    this.receiverTotalChunks = 0;
    this.receiverChunks = [];
    this.receiverBitmap = [];
    this.receiverReceivedCount = 0;
    this.receiverMetadata = null;
    this.receiverScanCount = 0;
    this.receiverLastFpsCalcTime = Date.now();
    this.receiverCurrentFps = 0;
    this.receiverCompletedBlobUrl = null;

    // Worker State
    this.qrWorker = null;
    this.workerBusy = false;

    this.dom = {};
  }

  init() {
    this.cacheDOM();
    this.initQRWorker();
    this.bindEvents();
    this.handleRouting();
  }

  /* NATIVE GZIP COMPRESSION */
  async compressData(uint8Array) {
    if (typeof CompressionStream === 'undefined') return uint8Array;
    try {
      const stream = new Response(uint8Array).body.pipeThrough(new CompressionStream('gzip'));
      const compressedBuffer = await new Response(stream).arrayBuffer();
      const compressedBytes = new Uint8Array(compressedBuffer);
      return compressedBytes.byteLength < uint8Array.byteLength ? compressedBytes : uint8Array;
    } catch (e) {
      return uint8Array;
    }
  }

  async decompressData(uint8Array) {
    if (typeof DecompressionStream === 'undefined') return uint8Array;
    try {
      const stream = new Response(uint8Array).body.pipeThrough(new DecompressionStream('gzip'));
      const decompressedBuffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(decompressedBuffer);
    } catch (e) {
      return uint8Array;
    }
  }

  /* WEB WORKER SCANNING */
  initQRWorker() {
    try {
      const basePath = window.location.origin + window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '') + '/';
      const localJsqrUrl = basePath + 'libs/jsqr.min.js';

      const workerCode = `
        try {
          importScripts('${localJsqrUrl}');
        } catch (err) {
          try {
            importScripts('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js');
          } catch (e) {}
        }

        self.onmessage = function(e) {
          const { imageData, width, height } = e.data;
          if (typeof jsQR === 'undefined') {
            self.postMessage({ resultText: null });
            return;
          }

          try {
            const code = jsQR(imageData.data, width, height, { inversionAttempts: 'dontInvert' });
            self.postMessage({ resultText: code ? code.data : null });
          } catch (err) {
            self.postMessage({ resultText: null });
          }
        };
      `;

      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      this.qrWorker = new Worker(workerUrl);

      this.qrWorker.onmessage = (e) => {
        this.workerBusy = false;
        if (e.data && e.data.resultText) {
          this.processScannedPacket(e.data.resultText);
        }
      };

      this.qrWorker.onerror = () => {
        this.workerBusy = false;
        this.qrWorker = null;
      };
    } catch (e) {
      this.qrWorker = null;
    }
  }

  cacheDOM() {
    this.dom.tabs = document.querySelectorAll('.m3-pill-tab, .m3-bottom-nav-item');
    this.dom.views = document.querySelectorAll('.m3-view');
    this.dom.logoBtn = document.getElementById('logo-btn');
    this.dom.btnGotoSend = document.getElementById('btn-goto-send');
    this.dom.btnGotoReceive = document.getElementById('btn-goto-receive');

    this.dom.modeFileBtn = document.getElementById('input-mode-file');
    this.dom.modeLinkBtn = document.getElementById('input-mode-link');
    this.dom.fileSection = document.getElementById('file-input-section');
    this.dom.linkSection = document.getElementById('link-input-section');
    this.dom.dropZone = document.getElementById('drop-zone');
    this.dom.dropZonePrompt = document.getElementById('drop-zone-prompt');
    this.dom.filePicker = document.getElementById('file-picker');
    this.dom.fileInfoPreview = document.getElementById('file-info-preview');
    this.dom.previewFilename = document.getElementById('preview-filename');
    this.dom.previewFilesize = document.getElementById('preview-filesize');
    this.dom.previewFileBadge = document.getElementById('file-badge');
    this.dom.btnRemoveFile = document.getElementById('btn-remove-file');
    this.dom.linkTextarea = document.getElementById('link-textarea');
    
    this.dom.compressionBadge = document.getElementById('compression-badge');
    this.dom.compressionText = document.getElementById('compression-text');

    this.dom.pairCodeVal = document.getElementById('pair-code-val');
    this.dom.modeWifiDirect = document.getElementById('mode-wifi-direct');
    this.dom.modeOpticalStream = document.getElementById('mode-optical-stream');
    this.dom.btnStartBeam = document.getElementById('btn-start-beam');

    this.dom.senderStatus = document.getElementById('sender-status');
    this.dom.senderChunkBadge = document.getElementById('sender-chunk-badge');
    this.dom.qrCanvas = document.getElementById('qr-canvas');
    this.dom.qrPlaceholder = document.getElementById('qr-placeholder');
    this.dom.senderProgressFill = document.getElementById('sender-progress-fill');
    this.dom.senderProgressText = document.getElementById('sender-progress-text');
    this.dom.senderTimeEst = document.getElementById('sender-time-est');
    this.dom.btnTogglePlay = document.getElementById('btn-toggle-play');
    this.dom.playIcon = document.getElementById('play-icon');
    this.dom.pauseIcon = document.getElementById('pause-icon');
    this.dom.btnPrevChunk = document.getElementById('btn-prev-chunk');
    this.dom.btnNextChunk = document.getElementById('btn-next-chunk');

    this.dom.inputPairCode = document.getElementById('input-pair-code');
    this.dom.btnConnectCode = document.getElementById('btn-connect-code');

    this.dom.cameraSelect = document.getElementById('camera-select');
    this.dom.scannerVideo = document.getElementById('scanner-video');
    this.dom.scannerCanvas = document.getElementById('scanner-canvas');
    this.dom.cameraPlaceholder = document.getElementById('camera-placeholder');
    this.dom.btnStartCamera = document.getElementById('btn-start-camera');
    this.dom.btnStopCamera = document.getElementById('btn-stop-camera');
    this.dom.receiverStatus = document.getElementById('receiver-status');
    
    this.dom.recFilename = document.getElementById('rec-filename');
    this.dom.recFilesize = document.getElementById('rec-filesize');
    this.dom.recChunksCount = document.getElementById('rec-chunks-count');
    this.dom.recPercent = document.getElementById('rec-percent');
    this.dom.recSpeed = document.getElementById('rec-speed');
    this.dom.defragCanvas = document.getElementById('defrag-canvas');
    this.dom.defragStatusBadge = document.getElementById('defrag-status-badge');
    this.dom.btnResetSession = document.getElementById('btn-reset-session');

    this.dom.completeBox = document.getElementById('complete-box');
    this.dom.completeSummary = document.getElementById('complete-summary');
    this.dom.fileDownloadActions = document.getElementById('file-download-actions');
    this.dom.btnDownloadFile = document.getElementById('btn-download-file');
    this.dom.linkOpenActions = document.getElementById('link-open-actions');
    this.dom.btnOpenLink = document.getElementById('btn-open-link');
    this.dom.btnCopyLink = document.getElementById('btn-copy-link');
  }

  bindEvents() {
    window.addEventListener('hashchange', () => this.handleRouting());
    if (this.dom.logoBtn) this.dom.logoBtn.addEventListener('click', () => this.navigateTo('home-view'));
    if (this.dom.btnGotoSend) this.dom.btnGotoSend.addEventListener('click', () => this.navigateTo('send-view'));
    if (this.dom.btnGotoReceive) this.dom.btnGotoReceive.addEventListener('click', () => this.navigateTo('receive-view'));

    this.dom.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-target');
        this.navigateTo(target);
      });
    });

    if (this.dom.modeFileBtn) this.dom.modeFileBtn.addEventListener('click', () => this.setSenderMode('file'));
    if (this.dom.modeLinkBtn) this.dom.modeLinkBtn.addEventListener('click', () => this.setSenderMode('link'));

    if (this.dom.dropZone) {
      this.dom.dropZone.addEventListener('click', (e) => {
        if (e.target !== this.dom.btnRemoveFile && !this.dom.btnRemoveFile.contains(e.target)) {
          this.dom.filePicker.click();
        }
      });
    }

    if (this.dom.filePicker) {
      this.dom.filePicker.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          this.handleFileSelect(e.target.files[0]);
        }
      });
    }

    if (this.dom.btnRemoveFile) {
      this.dom.btnRemoveFile.addEventListener('click', (e) => {
        e.stopPropagation();
        this.clearSelectedFile();
      });
    }

    if (this.dom.linkTextarea) {
      this.dom.linkTextarea.addEventListener('input', () => {
        this.linkText = this.dom.linkTextarea.value.trim();
        this.updateSenderButtonState();
      });
    }

    if (this.dom.btnStartBeam) this.dom.btnStartBeam.addEventListener('click', () => this.prepareSenderPayload());
    if (this.dom.btnTogglePlay) this.dom.btnTogglePlay.addEventListener('click', () => this.toggleSenderPlay());
    if (this.dom.btnPrevChunk) this.dom.btnPrevChunk.addEventListener('click', () => this.stepSenderChunk(-1));
    if (this.dom.btnNextChunk) this.dom.btnNextChunk.addEventListener('click', () => this.stepSenderChunk(1));

    if (this.dom.btnConnectCode) this.dom.btnConnectCode.addEventListener('click', () => this.connectViaPairCode());
    if (this.dom.inputPairCode) {
      this.dom.inputPairCode.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') this.connectViaPairCode();
      });
    }

    if (this.dom.btnStartCamera) this.dom.btnStartCamera.addEventListener('click', () => this.startCamera());
    if (this.dom.btnStopCamera) this.dom.btnStopCamera.addEventListener('click', () => this.stopCamera());
    if (this.dom.cameraSelect) this.dom.cameraSelect.addEventListener('change', () => this.switchCamera());
    if (this.dom.btnResetSession) this.dom.btnResetSession.addEventListener('click', () => this.resetReceiverSession());
    if (this.dom.btnCopyLink) this.dom.btnCopyLink.addEventListener('click', () => this.copyLinkToClipboard());
  }

  /* ROUTING & URL PARAMS */
  handleRouting() {
    const hash = window.location.hash.replace('#/', '');
    let target = 'home-view';
    if (hash.startsWith('send')) target = 'send-view';
    else if (hash.startsWith('receive')) target = 'receive-view';

    const urlParams = new URLSearchParams(window.location.search || hash.split('?')[1] || '');
    const codeParam = urlParams.get('code');

    this.navigateTo(target, false);

    if (target === 'receive-view' && codeParam) {
      this.dom.inputPairCode.value = codeParam;
      this.connectViaPairCode();
    }
  }

  navigateTo(viewId, updateHash = true) {
    this.currentView = viewId;

    this.dom.tabs.forEach(tab => {
      if (tab.getAttribute('data-target') === viewId) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    this.dom.views.forEach(view => {
      if (view.id === viewId) {
        view.classList.add('active');
      } else {
        view.classList.remove('active');
      }
    });

    if (updateHash) {
      if (viewId === 'send-view') window.location.hash = '#/send';
      else if (viewId === 'receive-view') window.location.hash = '#/receive';
      else window.location.hash = '#/';
    }

    if (viewId === 'send-view' && !this.pairCode) {
      this.generateSenderPairCode();
    } else if (viewId === 'receive-view' && !this.receiverScanning) {
      this.populateCameraDevices();
    } else if (viewId !== 'receive-view' && this.receiverScanning) {
      this.stopCamera();
    }
  }

  /* SENDER LOGIC */
  setSenderMode(mode) {
    this.senderMode = mode;
    if (mode === 'file') {
      this.dom.modeFileBtn.classList.add('active');
      this.dom.modeLinkBtn.classList.remove('active');
      this.dom.fileSection.classList.add('active');
      this.dom.linkSection.classList.remove('active');
    } else {
      this.dom.modeFileBtn.classList.remove('active');
      this.dom.modeLinkBtn.classList.add('active');
      this.dom.fileSection.classList.remove('active');
      this.dom.linkSection.classList.add('active');
    }
    this.updateSenderButtonState();
  }

  handleFileSelect(file) {
    if (!file) return;
    this.selectedFile = file;
    this.dom.previewFilename.innerText = file.name;
    this.dom.previewFilesize.innerText = this.formatBytes(file.size);
    
    const ext = file.name.split('.').pop().toUpperCase();
    this.dom.previewFileBadge.innerText = ext.length <= 4 ? ext : 'FILE';

    this.dom.dropZonePrompt.style.display = 'none';
    this.dom.fileInfoPreview.style.display = 'flex';

    const reader = new FileReader();
    reader.onload = (e) => {
      this.selectedFileBuffer = e.target.result;
      this.updateSenderButtonState();
    };
    reader.readAsArrayBuffer(file);
  }

  clearSelectedFile() {
    this.selectedFile = null;
    this.selectedFileBuffer = null;
    this.dom.filePicker.value = '';
    this.dom.dropZonePrompt.style.display = 'block';
    this.dom.fileInfoPreview.style.display = 'none';
    this.dom.compressionBadge.style.display = 'none';
    this.updateSenderButtonState();
    this.stopSender();
  }

  updateSenderButtonState() {
    let ready = false;
    if (this.senderMode === 'file' && this.selectedFileBuffer) {
      ready = true;
    } else if (this.senderMode === 'link' && this.linkText.length > 0) {
      ready = true;
    }
    this.dom.btnStartBeam.disabled = !ready;
  }

  /* PEERJS WI-FI P2P PAIRING */
  generateSenderPairCode() {
    this.pairCode = Math.floor(1000 + Math.random() * 9000).toString();
    this.dom.pairCodeVal.innerText = this.pairCode;

    if (typeof Peer !== 'undefined') {
      try {
        if (this.peer) this.peer.destroy();
        this.peer = new Peer('qrb-' + this.pairCode);

        this.peer.on('open', () => {
          this.dom.senderTimeEst.innerText = 'Wi-Fi P2P Ready (Code: ' + this.pairCode + ')';
        });

        this.peer.on('connection', (conn) => {
          this.activeConnection = conn;
          this.p2pConnected = true;
          this.dom.senderStatus.classList.add('active');
          this.dom.senderStatus.querySelector('.status-text').innerText = 'P2P Connected!';
          this.dom.senderTimeEst.innerText = 'Paired over Wi-Fi!';

          if (navigator.vibrate) navigator.vibrate(100);

          conn.on('open', () => {
            if (this.senderPayloadP2P) {
              conn.send(this.senderPayloadP2P);
            }
          });
        });
      } catch (e) {
        console.warn('PeerJS init warning:', e);
      }
    }
  }

  async prepareSenderPayload() {
    this.stopSender();
    const sessionId = Math.random().toString(16).substring(2, 6);

    let rawBytes = null;
    let meta = {};

    if (this.senderMode === 'file') {
      meta = {
        name: this.selectedFile.name,
        type: this.selectedFile.type || 'application/octet-stream',
        size: this.selectedFile.size
      };
      rawBytes = new Uint8Array(this.selectedFileBuffer);
    } else {
      const isUrl = /^(https?:\/\/)/i.test(this.linkText);
      meta = {
        isLink: isUrl,
        isText: !isUrl,
        url: isUrl ? this.linkText : undefined,
        text: !isUrl ? this.linkText : undefined,
        size: this.linkText.length
      };

      if (this.linkText.length < 300) {
        rawBytes = null;
      } else {
        const enc = new TextEncoder();
        rawBytes = enc.encode(this.linkText);
      }
    }

    let finalBytes = rawBytes;

    if (rawBytes && rawBytes.byteLength > 120) {
      const compressedBytes = await this.compressData(rawBytes);
      if (compressedBytes.byteLength < rawBytes.byteLength) {
        meta.isCompressed = true;
        meta.origSize = rawBytes.byteLength;
        meta.compSize = compressedBytes.byteLength;
        finalBytes = compressedBytes;

        const pct = Math.round((1 - compressedBytes.byteLength / rawBytes.byteLength) * 100);
        this.dom.compressionBadge.style.display = 'flex';
        this.dom.compressionText.innerText = `GZIP Compressed: ${this.formatBytes(rawBytes.byteLength)} → ${this.formatBytes(compressedBytes.byteLength)} (-${pct}%)`;
      } else {
        this.dom.compressionBadge.style.display = 'none';
      }
    } else {
      this.dom.compressionBadge.style.display = 'none';
    }

    // Save P2P payload
    this.senderPayloadP2P = { meta, bytes: finalBytes ? Array.from(finalBytes) : null };

    // Send immediately if P2P connection is already open
    if (this.activeConnection && this.activeConnection.open) {
      this.activeConnection.send(this.senderPayloadP2P);
    }

    // Chunk final bytes for optical QR stream backup
    let rawChunks = [];
    if (finalBytes) {
      const totalBytes = finalBytes.length;
      let offset = 0;
      while (offset < totalBytes) {
        const slice = finalBytes.subarray(offset, offset + this.senderChunkSize);
        rawChunks.push(this.uint8ArrayToBase64(slice));
        offset += this.senderChunkSize;
      }
    }

    const totalChunks = rawChunks.length + 1;
    this.senderPackets = [];

    // Single Pairing QR Code for 1-Scan Wi-Fi Connection
    const pairingUrl = window.location.origin + window.location.pathname + '#/receive?code=' + this.pairCode;
    const metaPayload = JSON.stringify(meta);
    this.senderPackets.push(`QRB1:${sessionId}:0:${totalChunks}:${metaPayload}`);

    for (let i = 0; i < rawChunks.length; i++) {
      const idx = i + 1;
      this.senderPackets.push(`QRB1:${sessionId}:${idx}:${totalChunks}:${rawChunks[i]}`);
    }

    this.senderCurrentIndex = 0;
    this.dom.qrPlaceholder.style.display = 'none';
    this.dom.btnTogglePlay.disabled = false;
    this.dom.btnPrevChunk.disabled = false;
    this.dom.btnNextChunk.disabled = false;

    // Render single pairing QR code first
    QRCode.toCanvas(this.dom.qrCanvas, pairingUrl, {
      errorCorrectionLevel: 'L',
      margin: 1,
      width: 360,
      color: { dark: '#000000', light: '#ffffff' }
    });

    this.startSender();
  }

  startSender() {
    this.senderIsPlaying = true;
    this.dom.playIcon.style.display = 'none';
    this.dom.pauseIcon.style.display = 'inline-block';
    
    this.dom.senderStatus.classList.add('active');
    this.dom.senderStatus.querySelector('.status-text').innerText = 'Transmitting';

    this.senderLastFrameTime = performance.now();
    this.senderLoop();
  }

  stopSender() {
    this.senderIsPlaying = false;
    if (this.senderTimerId) {
      cancelAnimationFrame(this.senderTimerId);
      this.senderTimerId = null;
    }
    this.dom.playIcon.style.display = 'inline-block';
    this.dom.pauseIcon.style.display = 'none';

    this.dom.senderStatus.classList.remove('active');
    this.dom.senderStatus.querySelector('.status-text').innerText = 'Paused';
  }

  toggleSenderPlay() {
    if (this.senderIsPlaying) {
      this.stopSender();
    } else {
      this.startSender();
    }
  }

  stepSenderChunk(delta) {
    this.stopSender();
    if (this.senderPackets.length === 0) return;
    this.senderCurrentIndex = (this.senderCurrentIndex + delta + this.senderPackets.length) % this.senderPackets.length;
    this.renderSenderFrame();
  }

  senderLoop(timestamp = performance.now()) {
    if (!this.senderIsPlaying) return;

    const interval = 1000 / this.senderFps;
    const elapsed = timestamp - this.senderLastFrameTime;

    if (elapsed >= interval) {
      this.senderLastFrameTime = timestamp - (elapsed % interval);
      this.renderSenderFrame();
      this.senderCurrentIndex = (this.senderCurrentIndex + 1) % this.senderPackets.length;
    }

    this.senderTimerId = requestAnimationFrame((ts) => this.senderLoop(ts));
  }

  renderSenderFrame() {
    const total = this.senderPackets.length;
    if (total === 0) return;

    const canvas = this.dom.qrCanvas;
    const packet = this.senderPackets[this.senderCurrentIndex % total];

    try {
      QRCode.toCanvas(canvas, packet, {
        errorCorrectionLevel: 'L',
        margin: 1,
        width: 360,
        color: { dark: '#000000', light: '#ffffff' }
      });
    } catch (e) {
      console.warn('QR Render error:', e);
    }

    const current = this.senderCurrentIndex + 1;
    const pct = Math.round((current / total) * 100);

    this.dom.senderChunkBadge.innerText = `Chunk ${current}/${total}`;
    this.dom.senderProgressFill.style.width = `${pct}%`;
    this.dom.senderProgressText.innerText = `${pct}% Complete`;
    
    const secondsPerLoop = (total / this.senderFps).toFixed(1);
    this.dom.senderTimeEst.innerText = `Loop: ${secondsPerLoop}s`;
  }

  /* RECEIVER LOGIC & PAIR CODE CONNECT */
  connectViaPairCode() {
    const code = this.dom.inputPairCode.value.trim();
    if (code.length !== 4) {
      alert('Please enter a 4-digit pair code (e.g. 4892)');
      return;
    }

    this.dom.recSpeed.innerText = 'Connecting...';

    if (typeof Peer !== 'undefined') {
      try {
        const clientPeer = new Peer();
        clientPeer.on('open', () => {
          const conn = clientPeer.connect('qrb-' + code);

          conn.on('open', () => {
            this.dom.recSpeed.innerText = 'P2P Connected!';
            this.dom.receiverStatus.classList.add('active');
            this.dom.receiverStatus.querySelector('.status-text').innerText = 'Connected!';

            if (navigator.vibrate) navigator.vibrate(100);
          });

          conn.on('data', async (data) => {
            if (data && data.meta) {
              this.receiverMetadata = data.meta;
              let assembledBytes = data.bytes ? new Uint8Array(data.bytes) : null;

              if (this.receiverMetadata.isCompressed && assembledBytes) {
                assembledBytes = await this.decompressData(assembledBytes);
              }

              this.completeReceiverDirect(assembledBytes);
            }
          });
        });
      } catch (e) {
        alert('Wi-Fi connection error. Use camera scan fallback.');
      }
    }
  }

  async populateCameraDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(device => device.kind === 'videoinput');

      this.dom.cameraSelect.innerHTML = '';
      if (videoInputs.length === 0) {
        const opt = document.createElement('option');
        opt.innerText = 'Default Camera';
        this.dom.cameraSelect.appendChild(opt);
        return;
      }

      videoInputs.forEach((device, i) => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.innerText = device.label || `Camera ${i + 1}`;
        if (device.label.toLowerCase().includes('back') || device.label.toLowerCase().includes('rear')) {
          opt.selected = true;
        }
        this.dom.cameraSelect.appendChild(opt);
      });
    } catch (err) {
      console.warn('Camera enumeration error:', err);
    }
  }

  async startCamera() {
    try {
      this.dom.cameraPlaceholder.style.display = 'none';
      const deviceId = this.dom.cameraSelect.value;

      const constraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
      };

      this.receiverStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.dom.scannerVideo.srcObject = this.receiverStream;
      this.dom.scannerVideo.setAttribute('playsinline', true);
      await this.dom.scannerVideo.play();

      this.receiverScanning = true;
      this.dom.btnStopCamera.style.display = 'flex';
      this.dom.receiverStatus.classList.add('active');
      this.dom.receiverStatus.querySelector('.status-text').innerText = 'Scanning Stream';

      this.receiverScanLoop();

    } catch (err) {
      alert('Unable to access camera. Use 4-digit Wi-Fi code entry.');
      this.dom.cameraPlaceholder.style.display = 'flex';
    }
  }

  stopCamera() {
    this.receiverScanning = false;
    if (this.receiverScanAnimId) {
      cancelAnimationFrame(this.receiverScanAnimId);
      this.receiverScanAnimId = null;
    }
    if (this.receiverStream) {
      this.receiverStream.getTracks().forEach(track => track.stop());
      this.receiverStream = null;
    }
    this.dom.scannerVideo.srcObject = null;
    this.dom.cameraPlaceholder.style.display = 'flex';
    this.dom.btnStopCamera.style.display = 'none';
    this.dom.receiverStatus.classList.remove('active');
    this.dom.receiverStatus.querySelector('.status-text').innerText = 'Camera Idle';
  }

  switchCamera() {
    if (this.receiverScanning) {
      this.stopCamera();
      this.startCamera();
    }
  }

  receiverScanLoop() {
    if (!this.receiverScanning) return;

    const video = this.dom.scannerVideo;
    const canvas = this.dom.scannerCanvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const scaleWidth = 280;
      const scaleHeight = Math.round((video.videoHeight / video.videoWidth) * scaleWidth);

      canvas.width = scaleWidth;
      canvas.height = scaleHeight;

      ctx.drawImage(video, 0, 0, scaleWidth, scaleHeight);

      this.receiverScanCount++;
      const now = Date.now();
      if (now - this.receiverLastFpsCalcTime >= 1000) {
        this.receiverCurrentFps = this.receiverScanCount;
        this.receiverScanCount = 0;
        this.receiverLastFpsCalcTime = now;
        this.dom.recSpeed.innerText = `${this.receiverCurrentFps} fps`;
      }

      const imageData = ctx.getImageData(0, 0, scaleWidth, scaleHeight);

      if (this.qrWorker && !this.workerBusy) {
        this.workerBusy = true;
        this.qrWorker.postMessage({ imageData, width: scaleWidth, height: scaleHeight });
      } else if (typeof jsQR !== 'undefined') {
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          this.processScannedPacket(code.data);
        }
      }
    }

    this.receiverScanAnimId = requestAnimationFrame(() => this.receiverScanLoop());
  }

  processScannedPacket(qrData) {
    if (qrData.includes('code=')) {
      const matchCode = qrData.match(/code=([0-9]{4})/);
      if (matchCode && matchCode[1]) {
        this.dom.inputPairCode.value = matchCode[1];
        this.connectViaPairCode();
        return;
      }
    }

    const match = qrData.match(/^(QRB1):([^:]+):([^:]+):([^:]+):(.*)$/);
    if (!match) return;

    const [_, magic, sessionId, indexStr, totalStr, payload] = match;
    const chunkIndex = parseInt(indexStr, 10);
    const totalChunks = parseInt(totalStr, 10);

    if (this.receiverSessionId !== sessionId) {
      this.initReceiverSession(sessionId, totalChunks);
    }

    if (this.receiverBitmap[chunkIndex]) {
      return;
    }

    this.receiverChunks[chunkIndex] = payload;
    this.receiverBitmap[chunkIndex] = true;
    this.receiverReceivedCount++;

    this.drawCanvasMatrixBlock(chunkIndex, true);

    if (chunkIndex === 0) {
      try {
        this.receiverMetadata = JSON.parse(payload);
        this.dom.recFilename.innerText = this.receiverMetadata.name || (this.receiverMetadata.isLink ? 'Web Link' : 'Text Message');
        this.dom.recFilesize.innerText = this.formatBytes(this.receiverMetadata.size || 0);
      } catch (e) {
        console.error('Metadata parse error:', e);
      }
    }

    const pct = Math.round((this.receiverReceivedCount / this.receiverTotalChunks) * 100);
    this.dom.recChunksCount.innerText = `${this.receiverReceivedCount} / ${this.receiverTotalChunks}`;
    this.dom.recPercent.innerText = `${pct}%`;

    if (this.receiverReceivedCount === this.receiverTotalChunks) {
      this.completeReceiverAssembly();
    }
  }

  /* 2D CANVAS MATRIX */
  initReceiverSession(sessionId, totalChunks) {
    this.receiverSessionId = sessionId;
    this.receiverTotalChunks = totalChunks;
    this.receiverChunks = new Array(totalChunks).fill(null);
    this.receiverBitmap = new Array(totalChunks).fill(false);
    this.receiverReceivedCount = 0;
    this.receiverMetadata = null;

    this.dom.recFilename.innerText = 'Receiving stream...';
    this.dom.recFilesize.innerText = '-- KB';
    this.dom.recChunksCount.innerText = `0 / ${totalChunks}`;
    this.dom.recPercent.innerText = '0%';
    this.dom.completeBox.style.display = 'none';
    this.dom.btnResetSession.style.display = 'inline-block';
    this.dom.defragStatusBadge.innerText = 'Receiving';
    this.dom.defragStatusBadge.style.color = 'var(--md-sys-color-primary)';

    this.initCanvasMatrixGrid();
  }

  initCanvasMatrixGrid() {
    const canvas = this.dom.defragCanvas;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const total = this.receiverTotalChunks || 1;
    const gap = 3;
    const cols = Math.ceil(Math.sqrt(total * (width / height)));
    const rows = Math.ceil(total / cols);

    const blockSizeX = (width - (cols + 1) * gap) / cols;
    const blockSizeY = (height - (rows + 1) * gap) / rows;
    const blockSize = Math.max(2, Math.min(blockSizeX, blockSizeY));

    this.matrixGridConfig = { cols, rows, blockSize, gap };

    ctx.fillStyle = '#33353c';
    for (let i = 0; i < total; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gap + col * (blockSize + gap);
      const y = gap + row * (blockSize + gap);

      ctx.beginPath();
      ctx.roundRect(x, y, blockSize, blockSize, 2);
      ctx.fill();
    }
  }

  drawCanvasMatrixBlock(chunkIndex, isReceived) {
    const canvas = this.dom.defragCanvas;
    if (!canvas || !this.matrixGridConfig) return;

    const ctx = canvas.getContext('2d');
    const { cols, blockSize, gap } = this.matrixGridConfig;

    const col = chunkIndex % cols;
    const row = Math.floor(chunkIndex / cols);
    const x = gap + col * (blockSize + gap);
    const y = gap + row * (blockSize + gap);

    ctx.fillStyle = isReceived ? '#7bdba3' : '#33353c';
    ctx.beginPath();
    ctx.roundRect(x, y, blockSize, blockSize, 2);
    ctx.fill();
  }

  resetReceiverSession() {
    this.receiverSessionId = null;
    this.receiverTotalChunks = 0;
    this.receiverChunks = [];
    this.receiverBitmap = [];
    this.receiverReceivedCount = 0;
    this.receiverMetadata = null;

    this.dom.recFilename.innerText = 'Waiting for connection...';
    this.dom.recFilesize.innerText = '-- KB';
    this.dom.recChunksCount.innerText = '0 / 0';
    this.dom.recPercent.innerText = '0%';
    
    const canvas = this.dom.defragCanvas;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    this.dom.completeBox.style.display = 'none';
    this.dom.btnResetSession.style.display = 'none';
    this.dom.defragStatusBadge.innerText = 'Standby';
    this.dom.defragStatusBadge.style.color = 'var(--md-sys-color-on-surface-variant)';
  }

  completeReceiverDirect(assembledBytes) {
    const meta = this.receiverMetadata || {};
    this.dom.defragStatusBadge.innerText = 'COMPLETE';
    this.dom.defragStatusBadge.style.color = 'var(--md-sys-color-success)';
    this.dom.completeBox.style.display = 'block';

    if (meta.isLink || meta.isText) {
      const rawText = meta.url || meta.text || (assembledBytes ? new TextDecoder().decode(assembledBytes) : '');
      const url = meta.url || (/^(https?:\/\/)/i.test(rawText) ? rawText : null);
      
      this.dom.fileDownloadActions.style.display = 'none';
      this.dom.linkOpenActions.style.display = 'flex';

      if (url) {
        this.dom.btnOpenLink.href = url;
        this.dom.btnOpenLink.style.display = 'inline-flex';
        this.dom.completeSummary.innerText = `Link received: ${url}`;
      } else {
        this.dom.btnOpenLink.style.display = 'none';
        this.dom.completeSummary.innerText = `Text received: "${rawText}"`;
      }
    } else {
      const mimeType = meta.type || 'application/octet-stream';
      const blob = new Blob([assembledBytes], { type: mimeType });

      if (this.receiverCompletedBlobUrl) {
        URL.revokeObjectURL(this.receiverCompletedBlobUrl);
      }
      this.receiverCompletedBlobUrl = URL.createObjectURL(blob);

      this.dom.fileDownloadActions.style.display = 'flex';
      this.dom.linkOpenActions.style.display = 'none';

      this.dom.btnDownloadFile.onclick = () => {
        const a = document.createElement('a');
        a.href = this.receiverCompletedBlobUrl;
        a.download = meta.name || 'received-file';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      };

      this.dom.completeSummary.innerText = `Successfully received "${meta.name}" (${this.formatBytes(blob.size)})`;
    }
  }

  async completeReceiverAssembly() {
    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }

    const meta = this.receiverMetadata || {};
    const dataSlices = [];
    for (let i = 1; i < this.receiverTotalChunks; i++) {
      if (this.receiverChunks[i]) {
        dataSlices.push(this.base64ToUint8Array(this.receiverChunks[i]));
      }
    }

    let assembledBytes = this.concatUint8Arrays(dataSlices);

    if (meta.isCompressed) {
      assembledBytes = await this.decompressData(assembledBytes);
    }

    this.completeReceiverDirect(assembledBytes);
  }

  concatUint8Arrays(arrays) {
    let totalLen = 0;
    for (const arr of arrays) totalLen += arr.length;
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  copyLinkToClipboard() {
    const meta = this.receiverMetadata || {};
    const textToCopy = meta.url || meta.text || '';
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy).then(() => {
        alert('Copied to clipboard!');
      }).catch(err => {
        console.error('Clipboard copy failed:', err);
      });
    }
  }

  uint8ArrayToBase64(uint8Array) {
    let binary = '';
    const len = uint8Array.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }

  base64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
}
