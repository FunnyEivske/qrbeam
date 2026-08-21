/**
 * QRBeam - High-Speed Mobile-Optimized Data Transfer Engine
 * Features: Native GZIP Compression & Decompression Streams, Web Worker scanning, 2D Canvas matrix.
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
    this.senderFps = 12;
    this.senderChunkSize = 256;
    this.senderPackets = [];
    this.senderCurrentIndex = 0;
    this.senderIsPlaying = false;
    this.senderTimerId = null;
    this.senderLastFrameTime = 0;
    this.senderSessionId = '';

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

    // DOM Elements Cache
    this.dom = {};
  }

  init() {
    this.initQRWorker();
    this.cacheDOM();
    this.bindEvents();
    this.handleRouting();
  }

  /* ================= NATIVE GZIP COMPRESSION & DECOMPRESSION ================= */
  async compressData(uint8Array) {
    if (typeof CompressionStream === 'undefined') return uint8Array;
    try {
      const stream = new Response(uint8Array).body.pipeThrough(new CompressionStream('gzip'));
      const compressedBuffer = await new Response(stream).arrayBuffer();
      const compressedBytes = new Uint8Array(compressedBuffer);
      return compressedBytes.byteLength < uint8Array.byteLength ? compressedBytes : uint8Array;
    } catch (e) {
      console.warn('Compression failed, using uncompressed fallback:', e);
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
      console.warn('Decompression failed, returning raw bytes:', e);
      return uint8Array;
    }
  }

  /* ================= INLINE WEB WORKER FOR HIGH-SPEED SCANNING ================= */
  initQRWorker() {
    const workerCode = `
      importScripts('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js');

      self.onmessage = function(e) {
        const { imageData, width, height } = e.data;
        try {
          const code = jsQR(imageData.data, width, height, { inversionAttempts: 'dontInvert' });
          self.postMessage({ result: code ? code.data : null });
        } catch (err) {
          self.postMessage({ result: null, error: err.message });
        }
      };
    `;

    try {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      this.qrWorker = new Worker(workerUrl);

      this.qrWorker.onmessage = (e) => {
        this.workerBusy = false;
        if (e.data && e.data.result) {
          this.processScannedPacket(e.data.result);
        }
      };

      this.qrWorker.onerror = (err) => {
        console.warn('Worker scan error fallback to main thread:', err);
        this.workerBusy = false;
      };
    } catch (e) {
      console.warn('Worker creation failed, running on main thread:', e);
      this.qrWorker = null;
    }
  }

  cacheDOM() {
    // Navigation
    this.dom.tabs = document.querySelectorAll('.m3-pill-tab, .m3-bottom-nav-item');
    this.dom.bottomNavItems = document.querySelectorAll('.m3-bottom-nav-item');
    this.dom.views = document.querySelectorAll('.m3-view');
    this.dom.logoBtn = document.getElementById('logo-btn');
    this.dom.btnGotoSend = document.getElementById('btn-goto-send');
    this.dom.btnGotoReceive = document.getElementById('btn-goto-receive');

    // Sender Elements
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
    
    // Compression Badge
    this.dom.compressionBadge = document.getElementById('compression-badge');
    this.dom.compressionText = document.getElementById('compression-text');

    // Presets
    this.dom.presetMobileFast = document.getElementById('preset-mobile-fast');
    this.dom.presetBalanced = document.getElementById('preset-balanced');
    this.dom.presetDense = document.getElementById('preset-dense');

    this.dom.sliderFps = document.getElementById('slider-fps');
    this.dom.valFps = document.getElementById('val-fps');
    this.dom.sliderChunkSize = document.getElementById('slider-chunk-size');
    this.dom.valChunkSize = document.getElementById('val-chunk-size');
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

    // Receiver Elements
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
    this.dom.logoBtn.addEventListener('click', () => this.navigateTo('home-view'));
    this.dom.btnGotoSend.addEventListener('click', () => this.navigateTo('send-view'));
    this.dom.btnGotoReceive.addEventListener('click', () => this.navigateTo('receive-view'));

    this.dom.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-target');
        this.navigateTo(target);
      });
    });

    this.dom.modeFileBtn.addEventListener('click', () => this.setSenderMode('file'));
    this.dom.modeLinkBtn.addEventListener('click', () => this.setSenderMode('link'));

    this.dom.dropZone.addEventListener('click', (e) => {
      if (e.target !== this.dom.btnRemoveFile && !this.dom.btnRemoveFile.contains(e.target)) {
        this.dom.filePicker.click();
      }
    });

    this.dom.filePicker.addEventListener('change', (e) => this.handleFileSelect(e.target.files[0]));

    ['dragenter', 'dragover'].forEach(eventName => {
      this.dom.dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        this.dom.dropZone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      this.dom.dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        this.dom.dropZone.classList.remove('dragover');
      });
    });

    this.dom.dropZone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt.files && dt.files.length > 0) {
        this.handleFileSelect(dt.files[0]);
      }
    });

    this.dom.btnRemoveFile.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearSelectedFile();
    });

    this.dom.linkTextarea.addEventListener('input', () => {
      this.linkText = this.dom.linkTextarea.value.trim();
      this.updateSenderButtonState();
    });

    this.dom.presetMobileFast.addEventListener('click', () => this.applyPreset(256, 12, this.dom.presetMobileFast));
    this.dom.presetBalanced.addEventListener('click', () => this.applyPreset(384, 12, this.dom.presetBalanced));
    this.dom.presetDense.addEventListener('click', () => this.applyPreset(768, 15, this.dom.presetDense));

    this.dom.sliderFps.addEventListener('input', (e) => {
      this.senderFps = parseInt(e.target.value, 10);
      this.dom.valFps.innerText = `${this.senderFps} FPS`;
    });

    this.dom.sliderChunkSize.addEventListener('input', (e) => {
      this.senderChunkSize = parseInt(e.target.value, 10);
      this.dom.valChunkSize.innerText = `${this.senderChunkSize} Bytes`;
      if (this.senderPackets.length > 0) {
        this.prepareSenderPayload();
      }
    });

    this.dom.btnStartBeam.addEventListener('click', () => this.prepareSenderPayload());
    this.dom.btnTogglePlay.addEventListener('click', () => this.toggleSenderPlay());
    this.dom.btnPrevChunk.addEventListener('click', () => this.stepSenderChunk(-1));
    this.dom.btnNextChunk.addEventListener('click', () => this.stepSenderChunk(1));

    this.dom.btnStartCamera.addEventListener('click', () => this.startCamera());
    this.dom.btnStopCamera.addEventListener('click', () => this.stopCamera());
    this.dom.cameraSelect.addEventListener('change', () => this.switchCamera());
    this.dom.btnResetSession.addEventListener('click', () => this.resetReceiverSession());
    this.dom.btnCopyLink.addEventListener('click', () => this.copyLinkToClipboard());
  }

  applyPreset(chunkSize, fps, activeBtn) {
    [this.dom.presetMobileFast, this.dom.presetBalanced, this.dom.presetDense].forEach(btn => btn.classList.remove('active'));
    activeBtn.classList.add('active');

    this.senderChunkSize = chunkSize;
    this.senderFps = fps;

    this.dom.sliderChunkSize.value = chunkSize;
    this.dom.valChunkSize.innerText = `${chunkSize} Bytes`;

    this.dom.sliderFps.value = fps;
    this.dom.valFps.innerText = `${fps} FPS`;

    if (this.senderPackets.length > 0) {
      this.prepareSenderPayload();
    }
  }

  /* ROUTING */
  handleRouting() {
    const hash = window.location.hash.replace('#/', '');
    let target = 'home-view';
    if (hash === 'send') target = 'send-view';
    else if (hash === 'receive') target = 'receive-view';

    this.navigateTo(target, false);
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

    if (viewId === 'receive-view' && !this.receiverScanning) {
      this.populateCameraDevices();
    } else if (viewId !== 'receive-view' && this.receiverScanning) {
      this.stopCamera();
    }
  }

  /* SENDER LOGIC WITH SMART GZIP COMPRESSION */
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

  async prepareSenderPayload() {
    this.stopSender();
    this.senderSessionId = Math.random().toString(16).substring(2, 6);

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
        rawBytes = null; // direct metadata link
      } else {
        const enc = new TextEncoder();
        rawBytes = enc.encode(this.linkText);
      }
    }

    let finalBytes = rawBytes;

    // Smart GZIP Compression Check
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

    // Chunk final bytes
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

    // Packet 0: Metadata
    const metaPayload = JSON.stringify(meta);
    this.senderPackets.push(`QRB1:${this.senderSessionId}:0:${totalChunks}:${metaPayload}`);

    // Packets 1..N: Data
    for (let i = 0; i < rawChunks.length; i++) {
      const idx = i + 1;
      this.senderPackets.push(`QRB1:${this.senderSessionId}:${idx}:${totalChunks}:${rawChunks[i]}`);
    }

    this.senderCurrentIndex = 0;
    this.dom.qrPlaceholder.style.display = 'none';
    this.dom.btnTogglePlay.disabled = false;
    this.dom.btnPrevChunk.disabled = false;
    this.dom.btnNextChunk.disabled = false;

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
    const packet = this.senderPackets[this.senderCurrentIndex];
    if (!packet) return;

    QRCode.toCanvas(this.dom.qrCanvas, packet, {
      errorCorrectionLevel: 'L',
      margin: 1,
      width: 400,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    }, (error) => {
      if (error) console.error('QR Render Error:', error);
    });

    const total = this.senderPackets.length;
    const current = this.senderCurrentIndex + 1;
    const pct = Math.round((current / total) * 100);

    this.dom.senderChunkBadge.innerText = `Chunk ${current}/${total}`;
    this.dom.senderProgressFill.style.width = `${pct}%`;
    this.dom.senderProgressText.innerText = `${pct}% Complete`;
    
    const secondsPerLoop = (total / this.senderFps).toFixed(1);
    this.dom.senderTimeEst.innerText = `Loop: ${secondsPerLoop}s`;
  }

  /* RECEIVER LOGIC WITH AUTOMATIC DECOMPRESSION */
  async populateCameraDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(device => device.kind === 'videoinput');

      this.dom.cameraSelect.innerHTML = '';
      if (videoInputs.length === 0) {
        const opt = document.createElement('option');
        opt.innerText = 'No camera found';
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
      console.error('Camera access denied:', err);
      alert('Unable to access camera. Please allow camera permissions in browser settings.');
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

      if (this.qrWorker && !this.workerBusy) {
        const imageData = ctx.getImageData(0, 0, scaleWidth, scaleHeight);
        this.workerBusy = true;
        this.qrWorker.postMessage({ imageData, width: scaleWidth, height: scaleHeight });
      } else if (!this.qrWorker) {
        const imageData = ctx.getImageData(0, 0, scaleWidth, scaleHeight);
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          this.processScannedPacket(code.data);
        }
      }
    }

    this.receiverScanAnimId = requestAnimationFrame(() => this.receiverScanLoop());
  }

  processScannedPacket(qrData) {
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

    this.dom.recFilename.innerText = 'Waiting for stream...';
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

  async completeReceiverAssembly() {
    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }

    this.dom.defragStatusBadge.innerText = 'COMPLETE';
    this.dom.defragStatusBadge.style.color = 'var(--md-sys-color-success)';
    this.dom.completeBox.style.display = 'block';

    const meta = this.receiverMetadata || {};

    if (meta.isLink || meta.isText) {
      let rawText = '';
      if (meta.isCompressed && this.receiverTotalChunks > 1) {
        // Decompress long text
        const slices = [];
        for (let i = 1; i < this.receiverTotalChunks; i++) {
          if (this.receiverChunks[i]) {
            slices.push(this.base64ToUint8Array(this.receiverChunks[i]));
          }
        }
        const combined = this.concatUint8Arrays(slices);
        const decompressed = await this.decompressData(combined);
        const dec = new TextDecoder();
        rawText = dec.decode(decompressed);
      } else {
        rawText = meta.url || meta.text || '';
      }

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
      // Reassemble file slices
      const dataSlices = [];
      for (let i = 1; i < this.receiverTotalChunks; i++) {
        const base64 = this.receiverChunks[i];
        if (base64) {
          dataSlices.push(this.base64ToUint8Array(base64));
        }
      }

      let assembledBytes = this.concatUint8Arrays(dataSlices);

      // Automatic Decompression if meta.isCompressed is true
      if (meta.isCompressed) {
        assembledBytes = await this.decompressData(assembledBytes);
      }

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

      const originalInfo = meta.isCompressed ? ` (Decompressed from ${this.formatBytes(meta.compSize)} to ${this.formatBytes(blob.size)})` : ` (${this.formatBytes(blob.size)})`;
      this.dom.completeSummary.innerText = `Successfully reassembled "${meta.name}"${originalInfo}`;
    }
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

  /* UTILITY HELPERS */
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
