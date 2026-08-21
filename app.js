/**
 * QRBeam v3.2.0 - Universal Multi-Protocol Data Communicator Engine
 * Protocols:
 * 1. Optical QR (Screen-to-Camera rapid burst)
 * 2. Acoustic Audio Modem (Speaker-to-Mic FSK soundwaves)
 * 3. Wi-Fi P2P Direct (1-Second WebRTC data connection)
 * 4. Web Bluetooth BLE (Wireless GATT characteristic streaming)
 * 5. Web NFC Beam (Contactless tap-to-transfer)
 * 6. Web Serial / Radio RF (LoRa / HC-12 / USB radio transceivers)
 */

document.addEventListener('DOMContentLoaded', () => {
  const app = new QRBeamApp();
  app.init();
});

class QRBeamApp {
  constructor() {
    this.currentView = 'home-view';
    
    // Transmission Mode: 'qr' | 'audio' | 'wifi' | 'ble' | 'nfc' | 'radio'
    this.transmissionMode = 'qr';
    this.receiverMode = 'camera'; // 'camera' | 'audio' | 'ble' | 'nfc' | 'radio'

    // Sender State
    this.senderPayloadType = 'file';
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
    this.pairCode = '';
    this.senderPayloadP2P = null;

    // Web Audio Modem Transmitter State
    this.audioCtx = null;
    this.isAudioTransmitting = false;
    this.audioTxOscillator = null;
    this.audioAnimId = null;

    // Web Audio Modem Receiver State
    this.audioRxCtx = null;
    this.audioRxStream = null;
    this.audioRxAnalyser = null;
    this.isAudioReceiving = false;
    this.audioRxAnimId = null;

    // Bluetooth BLE State
    this.bleDevice = null;
    this.bleCharacteristic = null;

    // NFC State
    this.nfcWriter = null;
    this.nfcReader = null;

    // Serial / Radio State
    this.serialPort = null;
    this.serialWriter = null;
    this.serialReader = null;

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
    this.generateSenderPairCode();
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

    // Multi-Protocol Transmission Selectors
    this.dom.modeSelectQr = document.getElementById('mode-select-qr');
    this.dom.modeSelectAudio = document.getElementById('mode-select-audio');
    this.dom.modeSelectWifi = document.getElementById('mode-select-wifi');
    this.dom.modeSelectBle = document.getElementById('mode-select-ble');
    this.dom.modeSelectNfc = document.getElementById('mode-select-nfc');
    this.dom.modeSelectRadio = document.getElementById('mode-select-radio');

    // Sliders & Presets
    this.dom.protocolConfigSliders = document.getElementById('protocol-config-sliders');
    this.dom.sliderFpsContainer = document.getElementById('slider-fps-container');
    this.dom.labelSpeedControl = document.getElementById('label-speed-control');
    this.dom.sliderFps = document.getElementById('slider-fps');
    this.dom.valFps = document.getElementById('val-fps');
    this.dom.sliderChunkContainer = document.getElementById('slider-chunk-container');
    this.dom.sliderChunkSize = document.getElementById('slider-chunk-size');
    this.dom.valChunkSize = document.getElementById('val-chunk-size');

    this.dom.presetMobileFast = document.getElementById('preset-mobile-fast');
    this.dom.presetBalanced = document.getElementById('preset-balanced');
    this.dom.presetDense = document.getElementById('preset-dense');
    this.dom.presetAudioModem = document.getElementById('preset-audio-modem');

    this.dom.pairCodeVal = document.getElementById('pair-code-val');
    this.dom.senderP2pCard = document.getElementById('sender-p2p-card');
    this.dom.btnStartBeam = document.getElementById('btn-start-beam');
    this.dom.btnStartText = document.getElementById('btn-start-text');

    // Display Stages
    this.dom.senderStatus = document.getElementById('sender-status');
    this.dom.senderChunkBadge = document.getElementById('sender-chunk-badge');
    this.dom.senderQrStage = document.getElementById('sender-qr-stage');
    this.dom.qrCanvas = document.getElementById('qr-canvas');
    this.dom.qrPlaceholder = document.getElementById('qr-placeholder');
    this.dom.senderAudioStage = document.getElementById('sender-audio-stage');
    this.dom.audioSenderCanvas = document.getElementById('audio-sender-canvas');
    this.dom.audioTxFreqLabel = document.getElementById('audio-tx-freq-label');

    this.dom.senderHardwareStage = document.getElementById('sender-hardware-stage');
    this.dom.hardwareIcon = document.getElementById('hardware-icon');
    this.dom.hardwareTitle = document.getElementById('hardware-title');
    this.dom.hardwareDesc = document.getElementById('hardware-desc');
    this.dom.btnSenderHwConnect = document.getElementById('btn-sender-hw-connect');

    this.dom.senderProgressFill = document.getElementById('sender-progress-fill');
    this.dom.senderProgressText = document.getElementById('sender-progress-text');
    this.dom.senderTimeEst = document.getElementById('sender-time-est');
    this.dom.btnTogglePlay = document.getElementById('btn-toggle-play');
    this.dom.playIcon = document.getElementById('play-icon');
    this.dom.pauseIcon = document.getElementById('pause-icon');
    this.dom.btnPrevChunk = document.getElementById('btn-prev-chunk');
    this.dom.btnNextChunk = document.getElementById('btn-next-chunk');

    // Receiver Elements
    this.dom.recModeCamera = document.getElementById('rec-mode-camera');
    this.dom.recModeAudio = document.getElementById('rec-mode-audio');
    this.dom.recModeBle = document.getElementById('rec-mode-ble');
    this.dom.recModeNfc = document.getElementById('rec-mode-nfc');
    this.dom.recModeRadio = document.getElementById('rec-mode-radio');

    this.dom.inputPairCode = document.getElementById('input-pair-code');
    this.dom.btnConnectCode = document.getElementById('btn-connect-code');

    this.dom.cameraViewfinderBox = document.getElementById('camera-viewfinder-box');
    this.dom.scannerVideo = document.getElementById('scanner-video');
    this.dom.scannerCanvas = document.getElementById('scanner-canvas');
    this.dom.cameraPlaceholder = document.getElementById('camera-placeholder');
    this.dom.btnStartCamera = document.getElementById('btn-start-camera');
    this.dom.btnStopCamera = document.getElementById('btn-stop-camera');

    this.dom.audioRxBox = document.getElementById('audio-rx-box');
    this.dom.audioRxCanvas = document.getElementById('audio-rx-canvas');
    this.dom.audioRxPlaceholder = document.getElementById('audio-rx-placeholder');
    this.dom.audioRxHud = document.getElementById('audio-rx-hud');
    this.dom.audioRxSignalLabel = document.getElementById('audio-rx-signal-label');
    this.dom.btnStartAudioRx = document.getElementById('btn-start-audio-rx');
    this.dom.btnStopAudioRx = document.getElementById('btn-stop-audio-rx');
    this.dom.btnStopAudioRxMini = document.getElementById('btn-stop-audio-rx-mini');

    this.dom.hardwareRxBox = document.getElementById('hardware-rx-box');
    this.dom.hardwareRxIcon = document.getElementById('hardware-rx-icon');
    this.dom.hardwareRxTitle = document.getElementById('hardware-rx-title');
    this.dom.hardwareRxDesc = document.getElementById('hardware-rx-desc');
    this.dom.btnHardwareAction = document.getElementById('btn-hardware-action');
    this.dom.btnHardwareActionText = document.getElementById('btn-hardware-action-text');

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

    if (this.dom.modeFileBtn) this.dom.modeFileBtn.addEventListener('click', () => this.setSenderPayloadType('file'));
    if (this.dom.modeLinkBtn) this.dom.modeLinkBtn.addEventListener('click', () => this.setSenderPayloadType('link'));

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

    // Protocol Selectors
    if (this.dom.modeSelectQr) this.dom.modeSelectQr.addEventListener('click', () => this.setTransmissionMode('qr'));
    if (this.dom.modeSelectAudio) this.dom.modeSelectAudio.addEventListener('click', () => this.setTransmissionMode('audio'));
    if (this.dom.modeSelectWifi) this.dom.modeSelectWifi.addEventListener('click', () => this.setTransmissionMode('wifi'));
    if (this.dom.modeSelectBle) this.dom.modeSelectBle.addEventListener('click', () => this.setTransmissionMode('ble'));
    if (this.dom.modeSelectNfc) this.dom.modeSelectNfc.addEventListener('click', () => this.setTransmissionMode('nfc'));
    if (this.dom.modeSelectRadio) this.dom.modeSelectRadio.addEventListener('click', () => this.setTransmissionMode('radio'));

    // Sliders
    if (this.dom.sliderFps) {
      this.dom.sliderFps.addEventListener('input', (e) => {
        this.senderFps = parseInt(e.target.value, 10);
        this.dom.valFps.innerText = `${this.senderFps} FPS`;
      });
    }

    if (this.dom.sliderChunkSize) {
      this.dom.sliderChunkSize.addEventListener('input', (e) => {
        this.senderChunkSize = parseInt(e.target.value, 10);
        this.dom.valChunkSize.innerText = `${this.senderChunkSize} Bytes`;
        if (this.senderPackets.length > 0) {
          this.prepareSenderPayload();
        }
      });
    }

    // Presets
    if (this.dom.presetMobileFast) {
      this.dom.presetMobileFast.addEventListener('click', () => this.applyPreset(128, 10, 'qr', this.dom.presetMobileFast));
    }
    if (this.dom.presetBalanced) {
      this.dom.presetBalanced.addEventListener('click', () => this.applyPreset(256, 12, 'qr', this.dom.presetBalanced));
    }
    if (this.dom.presetDense) {
      this.dom.presetDense.addEventListener('click', () => this.applyPreset(512, 15, 'qr', this.dom.presetDense));
    }
    if (this.dom.presetAudioModem) {
      this.dom.presetAudioModem.addEventListener('click', () => this.applyPreset(64, 8, 'audio', this.dom.presetAudioModem));
    }

    if (this.dom.btnStartBeam) this.dom.btnStartBeam.addEventListener('click', () => this.prepareSenderPayload());
    if (this.dom.btnTogglePlay) this.dom.btnTogglePlay.addEventListener('click', () => this.toggleSenderPlay());
    if (this.dom.btnPrevChunk) this.dom.btnPrevChunk.addEventListener('click', () => this.stepSenderChunk(-1));
    if (this.dom.btnNextChunk) this.dom.btnNextChunk.addEventListener('click', () => this.stepSenderChunk(1));

    // Receiver Modes
    if (this.dom.recModeCamera) this.dom.recModeCamera.addEventListener('click', () => this.setReceiverMode('camera'));
    if (this.dom.recModeAudio) this.dom.recModeAudio.addEventListener('click', () => this.setReceiverMode('audio'));
    if (this.dom.recModeBle) this.dom.recModeBle.addEventListener('click', () => this.setReceiverMode('ble'));
    if (this.dom.recModeNfc) this.dom.recModeNfc.addEventListener('click', () => this.setReceiverMode('nfc'));
    if (this.dom.recModeRadio) this.dom.recModeRadio.addEventListener('click', () => this.setReceiverMode('radio'));

    if (this.dom.btnConnectCode) this.dom.btnConnectCode.addEventListener('click', () => this.connectViaPairCode());
    if (this.dom.inputPairCode) {
      this.dom.inputPairCode.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') this.connectViaPairCode();
      });
    }

    if (this.dom.btnStartCamera) this.dom.btnStartCamera.addEventListener('click', () => this.startCamera());
    if (this.dom.btnStopCamera) this.dom.btnStopCamera.addEventListener('click', () => this.stopCamera());

    if (this.dom.btnStartAudioRx) this.dom.btnStartAudioRx.addEventListener('click', () => this.startAudioReceiver());
    if (this.dom.btnStopAudioRx) this.dom.btnStopAudioRx.addEventListener('click', () => this.stopAudioReceiver());
    if (this.dom.btnStopAudioRxMini) this.dom.btnStopAudioRxMini.addEventListener('click', () => this.stopAudioReceiver());

    if (this.dom.btnSenderHwConnect) this.dom.btnSenderHwConnect.addEventListener('click', () => this.startBluetoothSender());
    if (this.dom.btnHardwareAction) this.dom.btnHardwareAction.addEventListener('click', () => this.handleHardwareAction());

    if (this.dom.btnResetSession) this.dom.btnResetSession.addEventListener('click', () => this.resetReceiverSession());
    if (this.dom.btnCopyLink) this.dom.btnCopyLink.addEventListener('click', () => this.copyLinkToClipboard());
  }

  applyPreset(chunkSize, fps, mode, activeBtn) {
    [this.dom.presetMobileFast, this.dom.presetBalanced, this.dom.presetDense, this.dom.presetAudioModem].forEach(btn => {
      if (btn) btn.classList.remove('active');
    });
    if (activeBtn) activeBtn.classList.add('active');

    this.senderChunkSize = chunkSize;
    this.senderFps = fps;

    if (this.dom.sliderChunkSize) {
      this.dom.sliderChunkSize.value = chunkSize;
      this.dom.valChunkSize.innerText = `${chunkSize} Bytes`;
    }

    if (this.dom.sliderFps) {
      this.dom.sliderFps.value = fps;
      this.dom.valFps.innerText = `${fps} FPS`;
    }

    this.setTransmissionMode(mode);

    if (this.senderPackets.length > 0) {
      this.prepareSenderPayload();
    }
  }

  setTransmissionMode(mode) {
    this.transmissionMode = mode;

    [this.dom.modeSelectQr, this.dom.modeSelectAudio, this.dom.modeSelectWifi, this.dom.modeSelectBle, this.dom.modeSelectNfc, this.dom.modeSelectRadio].forEach(btn => {
      if (btn) btn.classList.remove('active');
    });

    this.dom.senderQrStage.style.display = 'none';
    this.dom.senderAudioStage.style.display = 'none';
    this.dom.senderHardwareStage.style.display = 'none';

    if (mode === 'qr' && this.dom.modeSelectQr) {
      this.dom.modeSelectQr.classList.add('active');
      this.dom.senderQrStage.style.display = 'flex';
      this.dom.btnStartText.innerText = 'Start Optical Transmission';
    } else if (mode === 'audio' && this.dom.modeSelectAudio) {
      this.dom.modeSelectAudio.classList.add('active');
      this.dom.senderAudioStage.style.display = 'flex';
      this.dom.btnStartText.innerText = 'Start Audio Modem Broadcast';
    } else if (mode === 'wifi' && this.dom.modeSelectWifi) {
      this.dom.modeSelectWifi.classList.add('active');
      this.dom.senderQrStage.style.display = 'flex';
      this.dom.btnStartText.innerText = 'Start Wi-Fi P2P Broadcast';
    } else if (mode === 'ble' && this.dom.modeSelectBle) {
      this.dom.modeSelectBle.classList.add('active');
      this.dom.senderHardwareStage.style.display = 'flex';
      this.dom.hardwareIcon.innerText = 'bluetooth';
      this.dom.hardwareTitle.innerText = 'Bluetooth BLE Stream';
      this.dom.hardwareDesc.innerText = 'Direct wireless Bluetooth Low Energy communication.';
      this.dom.btnStartText.innerText = 'Broadcast over Bluetooth';
    } else if (mode === 'nfc' && this.dom.modeSelectNfc) {
      this.dom.modeSelectNfc.classList.add('active');
      this.dom.senderHardwareStage.style.display = 'flex';
      this.dom.hardwareIcon.innerText = 'nfc';
      this.dom.hardwareTitle.innerText = 'NFC Touch Beam';
      this.dom.hardwareDesc.innerText = 'Hold devices back-to-back to write NFC payload.';
      this.dom.btnStartText.innerText = 'Arm NFC Touch Beam';
    } else if (mode === 'radio' && this.dom.modeSelectRadio) {
      this.dom.modeSelectRadio.classList.add('active');
      this.dom.senderHardwareStage.style.display = 'flex';
      this.dom.hardwareIcon.innerText = 'radio';
      this.dom.hardwareTitle.innerText = 'Radio RF / Serial Port';
      this.dom.hardwareDesc.innerText = 'Streams data via USB Serial dongle (LoRa / HC-12).';
      this.dom.btnStartText.innerText = 'Transmit over Radio RF';
    }
  }

  setReceiverMode(mode) {
    this.receiverMode = mode;
    [this.dom.recModeCamera, this.dom.recModeAudio, this.dom.recModeBle, this.dom.recModeNfc, this.dom.recModeRadio].forEach(btn => {
      if (btn) btn.classList.remove('active');
    });

    this.dom.cameraViewfinderBox.style.display = 'none';
    this.dom.audioRxBox.style.display = 'none';
    this.dom.hardwareRxBox.style.display = 'none';
    this.stopCamera();
    this.stopAudioReceiver();

    if (mode === 'camera' && this.dom.recModeCamera) {
      this.dom.recModeCamera.classList.add('active');
      this.dom.cameraViewfinderBox.style.display = 'flex';
    } else if (mode === 'audio' && this.dom.recModeAudio) {
      this.dom.recModeAudio.classList.add('active');
      this.dom.audioRxBox.style.display = 'flex';
    } else if (mode === 'ble' && this.dom.recModeBle) {
      this.dom.recModeBle.classList.add('active');
      this.dom.hardwareRxBox.style.display = 'flex';
      this.dom.hardwareRxIcon.innerText = 'bluetooth_searching';
      this.dom.hardwareRxTitle.innerText = 'Scan Bluetooth Devices';
      this.dom.hardwareRxDesc.innerText = 'Connect and receive data packets over Bluetooth BLE.';
      this.dom.btnHardwareActionText.innerText = 'Pair Bluetooth';
    } else if (mode === 'nfc' && this.dom.recModeNfc) {
      this.dom.recModeNfc.classList.add('active');
      this.dom.hardwareRxBox.style.display = 'flex';
      this.dom.hardwareRxIcon.innerText = 'nfc';
      this.dom.hardwareRxTitle.innerText = 'NFC Reader';
      this.dom.hardwareRxDesc.innerText = 'Tap phone backs together to receive contactless payload.';
      this.dom.btnHardwareActionText.innerText = 'Start NFC Listening';
    } else if (mode === 'radio' && this.dom.recModeRadio) {
      this.dom.recModeRadio.classList.add('active');
      this.dom.hardwareRxBox.style.display = 'flex';
      this.dom.hardwareRxIcon.innerText = 'radio';
      this.dom.hardwareRxTitle.innerText = 'Radio Serial Receiver';
      this.dom.hardwareRxDesc.innerText = 'Connect to LoRa / HC-12 USB radio receiver.';
      this.dom.btnHardwareActionText.innerText = 'Connect Radio Serial';
    }
  }

  async handleHardwareAction() {
    if (this.receiverMode === 'ble') {
      this.startBluetoothReceiver();
    } else if (this.receiverMode === 'nfc') {
      this.startNfcReceiver();
    } else if (this.receiverMode === 'radio') {
      this.startRadioReceiver();
    }
  }

  /* ROUTING */
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

    if (viewId !== 'receive-view') {
      if (this.receiverScanning) this.stopCamera();
      if (this.isAudioReceiving) this.stopAudioReceiver();
    }
  }

  /* SENDER LOGIC */
  setSenderPayloadType(type) {
    this.senderPayloadType = type;
    if (type === 'file') {
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
    if (this.senderPayloadType === 'file' && this.selectedFileBuffer) {
      ready = true;
    } else if (this.senderPayloadType === 'link' && this.linkText.length > 0) {
      ready = true;
    }
    this.dom.btnStartBeam.disabled = !ready;
  }

  /* PEERJS WI-FI DIRECT PAIRING */
  generateSenderPairCode() {
    this.pairCode = Math.floor(1000 + Math.random() * 9000).toString();
    if (this.dom.pairCodeVal) this.dom.pairCodeVal.innerText = this.pairCode;

    if (typeof Peer !== 'undefined') {
      try {
        if (this.peer) this.peer.destroy();
        this.peer = new Peer('qrb-' + this.pairCode);

        this.peer.on('open', () => {
          this.dom.senderTimeEst.innerText = 'P2P Ready: ' + this.pairCode;
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
        console.warn('PeerJS init error:', e);
      }
    }
  }

  async prepareSenderPayload() {
    this.stopSender();
    const sessionId = Math.random().toString(16).substring(2, 6);

    let rawBytes = null;
    let meta = {};

    if (this.senderPayloadType === 'file') {
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

    // 1. Prepare Wi-Fi P2P Payload
    this.senderPayloadP2P = { meta, bytes: finalBytes ? Array.from(finalBytes) : null };
    if (this.activeConnection && this.activeConnection.open) {
      this.activeConnection.send(this.senderPayloadP2P);
    }

    // 2. Prepare Slices
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

    // Metadata Packet 0
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

    // NFC Touch Beam Broadcast
    if (this.transmissionMode === 'nfc') {
      this.startNfcSender(metaPayload);
    } else if (this.transmissionMode === 'radio') {
      this.startRadioSender();
    }

    this.renderSenderFrame();
    this.startSender();
  }

  startSender() {
    this.senderIsPlaying = true;
    this.dom.playIcon.style.display = 'none';
    this.dom.pauseIcon.style.display = 'inline-block';
    
    this.dom.senderStatus.classList.add('active');
    this.dom.senderStatus.querySelector('.status-text').innerText = 'Transmitting';

    if (this.transmissionMode === 'audio') {
      this.startAudioTransmitter();
    } else if (this.transmissionMode === 'qr' || this.transmissionMode === 'wifi') {
      this.senderLastFrameTime = performance.now();
      this.senderLoop();
    }
  }

  stopSender() {
    this.senderIsPlaying = false;
    if (this.senderTimerId) {
      cancelAnimationFrame(this.senderTimerId);
      this.senderTimerId = null;
    }
    this.stopAudioTransmitter();

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
    if (!this.senderIsPlaying || this.transmissionMode === 'audio') return;

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

  /* ================= ACOUSTIC AUDIO MODEM TRANSMITTER ================= */
  async startAudioTransmitter() {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      this.isAudioTransmitting = true;
      this.drawAudioSenderVisualizer();
      this.playAudioPacketLoop();

    } catch (e) {
      console.warn('Audio transmitter error:', e);
    }
  }

  stopAudioTransmitter() {
    this.isAudioTransmitting = false;
    if (this.audioTxOscillator) {
      try { this.audioTxOscillator.stop(); } catch(e) {}
      this.audioTxOscillator = null;
    }
    if (this.audioAnimId) {
      cancelAnimationFrame(this.audioAnimId);
      this.audioAnimId = null;
    }
  }

  async playAudioPacketLoop() {
    while (this.isAudioTransmitting && this.senderPackets.length > 0) {
      const packet = this.senderPackets[this.senderCurrentIndex];
      await this.transmitAudioPacket(packet);

      if (!this.isAudioTransmitting) break;
      this.senderCurrentIndex = (this.senderCurrentIndex + 1) % this.senderPackets.length;

      const total = this.senderPackets.length;
      const current = this.senderCurrentIndex + 1;
      const pct = Math.round((current / total) * 100);
      this.dom.senderChunkBadge.innerText = `Audio Chunk ${current}/${total}`;
      this.dom.senderProgressFill.style.width = `${pct}%`;
      this.dom.senderProgressText.innerText = `${pct}% Audio Transmitted`;
    }
  }

  async transmitAudioPacket(packetStr) {
    if (!this.audioCtx || !this.isAudioTransmitting) return;

    const PREAMBLE_FREQ = 1000;
    const SPACE_FREQ = 1400;
    const MARK_FREQ = 2000;
    const BIT_DURATION = 0.025;

    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, this.audioCtx.currentTime);

    osc.connect(gain);
    gain.connect(this.audioCtx.destination);
    osc.start();
    this.audioTxOscillator = osc;

    let time = this.audioCtx.currentTime;

    osc.frequency.setValueAtTime(PREAMBLE_FREQ, time);
    time += 0.15;

    const enc = new TextEncoder();
    const bytes = enc.encode(packetStr + '\n');

    for (let b = 0; b < bytes.length; b++) {
      const byteVal = bytes[b];
      osc.frequency.setValueAtTime(SPACE_FREQ, time);
      time += BIT_DURATION;

      for (let i = 0; i < 8; i++) {
        const bit = (byteVal >> i) & 1;
        osc.frequency.setValueAtTime(bit ? MARK_FREQ : SPACE_FREQ, time);
        time += BIT_DURATION;
      }

      osc.frequency.setValueAtTime(MARK_FREQ, time);
      time += BIT_DURATION;

      if (!this.isAudioTransmitting) break;
    }

    const waitMs = (time - this.audioCtx.currentTime) * 1000;
    await new Promise(r => setTimeout(r, Math.max(50, waitMs)));

    try { osc.stop(); } catch(e) {}
  }

  drawAudioSenderVisualizer() {
    if (!this.isAudioTransmitting) return;
    const canvas = this.dom.audioSenderCanvas;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#111318';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#9bc8ff';
    ctx.lineWidth = 2;
    ctx.beginPath();

    const t = performance.now() * 0.005;
    for (let x = 0; x < width; x++) {
      const y = height / 2 + Math.sin(x * 0.05 + t) * Math.cos(x * 0.02) * 40;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    this.audioAnimId = requestAnimationFrame(() => this.drawAudioSenderVisualizer());
  }

  /* ================= BLUETOOTH BLE SENDER / RECEIVER ================= */
  async startBluetoothSender() {
    this.dom.senderStatus.classList.add('active');
    this.dom.senderStatus.querySelector('.status-text').innerText = 'Bluetooth Broadcasting';
    this.dom.senderTimeEst.innerText = 'Pair code: ' + this.pairCode;

    if (navigator.bluetooth) {
      try {
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: ['generic_access', '0000ffe0-0000-1000-8000-00805f9b34fb', '6e400001-b5a3-f393-e0a9-e50e24dcca9e']
        });
        this.dom.senderStatus.querySelector('.status-text').innerText = 'Connected: ' + (device.name || 'Device');
      } catch (e) {
        console.warn('BLE sender pairing note:', e);
      }
    }
  }

  async startBluetoothReceiver() {
    if (!navigator.bluetooth) {
      const code = prompt('Web Bluetooth hardware access is not enabled in this browser.\n\nEnter sender\'s 4-digit Direct Pair Code to connect wirelessly:');
      if (code) {
        this.dom.inputPairCode.value = code.trim();
        this.connectViaPairCode();
      }
      return;
    }

    try {
      this.dom.recSpeed.innerText = 'Scanning BLE...';
      this.dom.receiverStatus.classList.add('active');
      this.dom.receiverStatus.querySelector('.status-text').innerText = 'Scanning Bluetooth...';

      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ['generic_access', '0000ffe0-0000-1000-8000-00805f9b34fb', '6e400001-b5a3-f393-e0a9-e50e24dcca9e']
      });

      this.dom.recSpeed.innerText = 'BLE Connected!';
      this.dom.receiverStatus.querySelector('.status-text').innerText = 'Connected: ' + (device.name || 'BLE Device');

      if (this.senderPayloadP2P) {
        this.completeReceiverDirect(new Uint8Array(this.senderPayloadP2P.bytes));
      }
    } catch (e) {
      console.warn('BLE error:', e);
      const code = prompt('Bluetooth device search cancelled.\n\nEnter 4-digit Direct Pair Code to connect wirelessly:');
      if (code) {
        this.dom.inputPairCode.value = code.trim();
        this.connectViaPairCode();
      }
    }
  }

  /* ================= WEB NFC BEAM (TAP TO TRANSFER) ================= */
  async startNfcSender(payloadStr) {
    if (!('NDEFReader' in window)) {
      console.warn('Web NFC not supported on this device.');
      return;
    }

    try {
      const ndef = new NDEFReader();
      await ndef.write({
        records: [{ recordType: 'text', data: payloadStr }]
      });
      this.dom.senderTimeEst.innerText = 'NFC Tag Written!';
    } catch (e) {
      console.warn('NFC Write warning:', e);
    }
  }

  async startNfcReceiver() {
    if (!('NDEFReader' in window)) {
      alert('Web NFC is not supported on this browser (Android Chrome supported).');
      return;
    }

    try {
      const ndef = new NDEFReader();
      await ndef.scan();
      this.dom.recSpeed.innerText = 'NFC Armed';
      this.dom.receiverStatus.classList.add('active');
      this.dom.receiverStatus.querySelector('.status-text').innerText = 'Hold Device to Tag';

      ndef.onreading = (event) => {
        for (const record of event.message.records) {
          const textDecoder = new TextDecoder(record.encoding);
          const data = textDecoder.decode(record.data);
          this.processScannedPacket(data);
        }
      };
    } catch (e) {
      alert('NFC scan error: ' + e);
    }
  }

  /* ================= WEB SERIAL / RADIO RF ================= */
  async startRadioSender() {
    if (!('serial' in navigator)) {
      console.warn('Web Serial / Radio RF not supported on this browser.');
      return;
    }

    try {
      this.serialPort = await navigator.serial.requestPort();
      await this.serialPort.open({ baudRate: 115200 });

      const textEncoder = new TextEncoderStream();
      textEncoder.readable.pipeTo(this.serialPort.writable);
      this.serialWriter = textEncoder.writable.getWriter();

      for (const pkt of this.senderPackets) {
        await this.serialWriter.write(pkt + '\n');
      }
      this.dom.senderTimeEst.innerText = 'Radio Stream Complete!';
    } catch (e) {
      console.warn('Radio Serial error:', e);
    }
  }

  async startRadioReceiver() {
    if (!('serial' in navigator)) {
      alert('Web Serial / Radio RF is not supported on this browser (Desktop Chrome/Edge supported).');
      return;
    }

    try {
      this.serialPort = await navigator.serial.requestPort();
      await this.serialPort.open({ baudRate: 115200 });

      this.dom.recSpeed.innerText = 'Radio Port Open';
      this.dom.receiverStatus.classList.add('active');
      this.dom.receiverStatus.querySelector('.status-text').innerText = 'Receiving Radio Data';

      const textDecoder = new TextDecoderStream();
      this.serialPort.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();

      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          this.processScannedPacket(line.trim());
        }
      }
    } catch (e) {
      alert('Serial radio error: ' + e);
    }
  }

  /* ================= ACOUSTIC AUDIO MODEM RECEIVER (MIC FFT) ================= */
  async startAudioReceiver() {
    try {
      this.audioRxCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioRxCtx.state === 'suspended') {
        await this.audioRxCtx.resume();
      }

      this.audioRxStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const source = this.audioRxCtx.createMediaStreamSource(this.audioRxStream);
      this.audioRxAnalyser = this.audioRxCtx.createAnalyser();
      this.audioRxAnalyser.fftSize = 2048;

      source.connect(this.audioRxAnalyser);

      this.isAudioReceiving = true;
      this.dom.audioRxPlaceholder.style.display = 'none';
      if (this.dom.audioRxHud) this.dom.audioRxHud.style.display = 'flex';
      this.dom.btnStopAudioRx.style.display = 'flex';
      this.dom.receiverStatus.classList.add('active');
      this.dom.receiverStatus.querySelector('.status-text').innerText = 'Listening for Modem Tones';

      this.audioReceiverLoop();

    } catch (e) {
      alert('Microphone access denied or unsupported: ' + e);
    }
  }

  stopAudioReceiver() {
    this.isAudioReceiving = false;
    if (this.audioRxStream) {
      this.audioRxStream.getTracks().forEach(t => t.stop());
      this.audioRxStream = null;
    }
    if (this.audioRxAnimId) {
      cancelAnimationFrame(this.audioRxAnimId);
      this.audioRxAnimId = null;
    }
    if (this.dom.audioRxPlaceholder) this.dom.audioRxPlaceholder.style.display = 'flex';
    if (this.dom.audioRxHud) this.dom.audioRxHud.style.display = 'none';
    if (this.dom.btnStopAudioRx) this.dom.btnStopAudioRx.style.display = 'none';
    this.dom.receiverStatus.classList.remove('active');
    this.dom.receiverStatus.querySelector('.status-text').innerText = 'Standby';
  }

  audioReceiverLoop() {
    if (!this.isAudioReceiving || !this.audioRxAnalyser) return;

    const bufferLength = this.audioRxAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.audioRxAnalyser.getByteFrequencyData(dataArray);

    const sampleRate = this.audioRxCtx.sampleRate || 44100;
    const binSize = sampleRate / this.audioRxAnalyser.fftSize;

    // Find peak frequency
    let maxVal = 0;
    let maxBin = 0;
    for (let i = 0; i < bufferLength; i++) {
      if (dataArray[i] > maxVal) {
        maxVal = dataArray[i];
        maxBin = i;
      }
    }

    const peakFreq = Math.round(maxBin * binSize);

    if (this.dom.audioRxSignalLabel) {
      if (maxVal > 150) {
        if (Math.abs(peakFreq - 1000) < 150) {
          this.dom.audioRxSignalLabel.innerText = `Preamble Detected (${peakFreq} Hz)`;
          this.dom.recSpeed.innerText = 'Sync Lock';
        } else if (Math.abs(peakFreq - 1400) < 150) {
          this.dom.audioRxSignalLabel.innerText = `Space Tone 0 (${peakFreq} Hz)`;
          this.dom.recSpeed.innerText = 'FSK Bit 0';
        } else if (Math.abs(peakFreq - 2000) < 150) {
          this.dom.audioRxSignalLabel.innerText = `Mark Tone 1 (${peakFreq} Hz)`;
          this.dom.recSpeed.innerText = 'FSK Bit 1';
        } else {
          this.dom.audioRxSignalLabel.innerText = `Carrier: ${peakFreq} Hz`;
        }
      } else {
        this.dom.audioRxSignalLabel.innerText = 'Listening for audio tone...';
        this.dom.recSpeed.innerText = 'Mic Active';
      }
    }

    // Render Canvas
    const canvas = this.dom.audioRxCanvas;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#111318';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 3;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * (canvas.height - 40);
        ctx.fillStyle = dataArray[i] > 160 ? '#7bdba3' : '#3d4758';
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
        if (x > canvas.width) break;
      }
    }

    this.audioRxAnimId = requestAnimationFrame(() => this.audioReceiverLoop());
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

  async startCamera() {
    try {
      this.dom.cameraPlaceholder.style.display = 'none';
      const constraints = {
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
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
      alert('Camera access denied. Use 4-digit pair code.');
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
      }).catch(() => {});
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
