// app.js
const fileInput = document.getElementById("fileInput");
const clearBtn = document.getElementById("clearBtn");
let noseBridgeStrength = 0;
let previewZoom = 1;

const startCamBtn = document.getElementById("startCamBtn");
const captureBtn = document.getElementById("captureBtn");
const video = document.getElementById("video");

const imgCanvas = document.getElementById("imgCanvas");
const overlayCanvas = document.getElementById("overlayCanvas");

const imgCtx = imgCanvas.getContext("2d");
const overlayCtx = overlayCanvas.getContext("2d");

const NOSE_BRIDGE_INDICES = [168, 6, 197, 195, 5];

const NOSE_BRIDGE_PRESETS = {
    off:    0.00,
    small:  0.012,
    medium: 0.020,
    large:  0.028
  };
  

const CHIN_PRESETS = {
    off:    { down: 0.00, forward: 0.00 },
    small:  { down: 0.04, forward: 0.01 },
    medium: { down: 0.07, forward: 0.02 },
    large:  { down: 0.10, forward: 0.03 }
  };
  
  const NOSE_PRESETS = {
    off:    { width: 0.00, tip: 0.00 },
    small:  { width: 0.04, tip: 0.005 },
    medium: { width: 0.07, tip: 0.01 },
    large:  { width: 0.10, tip: 0.015 }
  };
  

let baseImageData = null;   
let workingImageData = null;  
let faceMesh = null;
let currentImage = null;
let mediaStream = null;
let lastLandmarks = null;

let effectState = {
    chin: 0,   // 0 = off
    nose: 0    // 0 = off
};

let chinParams = CHIN_PRESETS.off;
let noseParams = NOSE_PRESETS.off;
let showBefore = false;

function toggleBeforeAfter() {
  if (!baseImageData) return;

  if (!showBefore) {
    imgCtx.putImageData(baseImageData, 0, 0);
  } else {
    renderEffects();
  }

  showBefore = !showBefore;
}



function applyZoom() {
  const scale = `scale(${previewZoom})`;
  imgCanvas.style.transform = scale;
  overlayCanvas.style.transform = scale;
}

function resetZoom() {
    previewZoom = 1;
    applyZoom();
  }
  


  function setNoseBridge(level) {
    noseBridgeStrength = NOSE_BRIDGE_PRESETS[level];
    renderEffects();
  }
  

  function renderEffects() {
    if (!baseImageData || !lastLandmarks) return;
  
    imgCtx.putImageData(baseImageData, 0, 0);
    workingImageData = imgCtx.getImageData(
      0, 0, imgCanvas.width, imgCanvas.height
    );
  
    if (chinParams.down > 0 || chinParams.forward > 0) {
      applyChinImplant(chinParams);
    }
  
    if (noseParams.width > 0 || noseParams.tip > 0) {
      applyNoseTrim(noseParams);
    }
  
    if (noseBridgeStrength > 0) {
      applyNoseBridgeSmoothing(noseBridgeStrength);
    }
  }


// ================== FACE REGIONS (MediaPipe indices) ==================

const CHIN_JAW_INDICES = [
    152,        // chin bottom
    377, 400, 378, 379, 365,   // right jaw
    136, 150, 149, 176, 148    // left jaw
  ];
  
// === NOSE OUTER CONTOUR (STABLE LOOP) ===
const NOSE_OUTLINE_INDICES = [
    168, // upper bridge
    197,
    195,
    5,
    4,
    45,  // left alar
    275, // right alar
    440,
    344,
    278
  ];

const NOSE_CENTERLINE = [168, 6, 197, 195, 5, 4, 2];
const NOSE_LEFT = [98, 94];
const NOSE_RIGHT = [327, 326];



/** ---------- Helpers ---------- **/
function setCanvasSize(w, h) {
  imgCanvas.width = w;
  imgCanvas.height = h;
  overlayCanvas.width = w;
  overlayCanvas.height = h;
}


function isAcceptableBridgeAngle(lm) {
    const leftEye = lm[33];
    const rightEye = lm[263];
  
    const eyeDistance = Math.abs(leftEye.x - rightEye.x);
  
    // Too small = extreme side profile
    return eyeDistance > 0.018;
  }
  

function centroid(points) {
    let x = 0, y = 0;
    points.forEach(p => { x += p.x; y += p.y; });
    return { x: x / points.length, y: y / points.length };
  }
  
  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  
  function applyChinImplant(params) {
    const lm = lastLandmarks;
    const chinPts = CHIN_JAW_INDICES.map(i => lmToPoint(lm[i]));
    const center = centroid(chinPts);
  
    let radius = 0;
    chinPts.forEach(p => radius = Math.max(radius, distance(p, center)));
  
    warpImage((x, y) => {
      const d = Math.hypot(x - center.x, y - center.y);
      if (d > radius) return { dx: 0, dy: 0 };
  
      const falloff = 1 - d / radius;
  
      return {
        dx: params.forward * falloff * radius, // forward projection
        dy: -params.down * falloff * radius     // vertical extension
      };
    });
  }
  
  function applyNoseBridgeSmoothing(strength = 0.02) {
    const lm = lastLandmarks;
    if (!lm) return;
  
    // ❌ Disable for extreme side view
    if (!isAcceptableBridgeAngle(lm)) return;
  
    // Convert bridge landmarks to canvas points
    const bridgePts = NOSE_BRIDGE_INDICES.map(i => lmToPoint(lm[i]));
  
    const top = bridgePts[0];
    const bottom = bridgePts[bridgePts.length - 1];
  
    // Direction vector of ideal straight bridge
    const dx = bottom.x - top.x;
    const dy = bottom.y - top.y;
    const len = Math.hypot(dx, dy);
  
    const nx = dx / len;
    const ny = dy / len;
  
    const influenceRadius = len * 0.45;
  
    warpImage((x, y) => {
      // Project point onto bridge line
      const px = x - top.x;
      const py = y - top.y;
  
      const t = px * nx + py * ny;
      if (t < 0 || t > len) return { dx: 0, dy: 0 };
  
      // Closest point on straight bridge
      const bx = top.x + t * nx;
      const by = top.y + t * ny;
  
      const dist = Math.hypot(x - bx, y - by);
      if (dist > influenceRadius) return { dx: 0, dy: 0 };
  
      // Smooth falloff
      const falloff = Math.pow(1 - dist / influenceRadius, 2.5);
  
      return {
        dx: (bx - x) * strength * falloff,
        dy: (by - y) * strength * falloff
      };
    });
  }
  

  
  function applyNoseTrim(params) {
    if (!lastLandmarks || !workingImageData) return;
  
    const lm = lastLandmarks;
  
    const leftPt = lmToPoint(lm[94]);
    const rightPt = lmToPoint(lm[326]);
    const centerX = (leftPt.x + rightPt.x) / 2;
    const centerY = (leftPt.y + rightPt.y) / 2;
  
    const noseWidth = Math.abs(rightPt.x - leftPt.x);
    const radius = Math.max(30, noseWidth * 2.2);
  
    warpImage((x, y) => {
      const dx = x - centerX;
      const dy = y - centerY;
  
      if (Math.abs(dx) > radius || Math.abs(dy) > radius) {
        return { dx: 0, dy: 0 };
      }
  
      const fx = 1 - Math.abs(dx) / radius;
      const fy = 1 - Math.abs(dy) / radius;
      const falloff = fx * fy;
  
      // Width narrowing
      const dir = dx < 0 ? 1 : -1;
      const widthPull = dir * params.width * falloff * radius;
  
      // Tip refinement (very subtle upward pull)
      const tipLift = -params.tip * falloff * radius;
  
      return {
        dx: widthPull,
        dy: tipLift
      };
    });
  }
  
  function readyToProcess() {
    if (!baseImageData) return;
  
    // Show clean image
    imgCtx.putImageData(baseImageData, 0, 0);
  
    // Hide detection overlays
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  
    // Lock into edit mode
    showBefore = true;
  }
  
  


  function setChin(level) {
    chinParams = CHIN_PRESETS[level];
    renderEffects();
  }
  
  function setNose(level) {
    noseParams = NOSE_PRESETS[level];
    renderEffects();
  }
  

  function lmToPoint(lm) {
    return {
      x: lm.x * imgCanvas.width,
      y: lm.y * imgCanvas.height
    };
  }
  
  
  

  function drawNoseStructure(lm) {
    overlayCtx.save();
  
    // Center line
    overlayCtx.strokeStyle = "orange";
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    NOSE_CENTERLINE.forEach((i, idx) => {
      const p = lmToPoint(lm[i]);
      if (idx === 0) overlayCtx.moveTo(p.x, p.y);
      else overlayCtx.lineTo(p.x, p.y);
    });
    overlayCtx.stroke();
  
    // Left alar
    overlayCtx.fillStyle = "orange";
    NOSE_LEFT.forEach(i => {
      const p = lmToPoint(lm[i]);
      overlayCtx.beginPath();
      overlayCtx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      overlayCtx.fill();
    });
  
    // Right alar
    NOSE_RIGHT.forEach(i => {
      const p = lmToPoint(lm[i]);
      overlayCtx.beginPath();
      overlayCtx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      overlayCtx.fill();
    });
  
    // Width line (computed, not landmark-based)
    const left = lmToPoint(lm[94]);
    const right = lmToPoint(lm[326]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(left.x, left.y);
    overlayCtx.lineTo(right.x, right.y);
    overlayCtx.stroke();
  
    overlayCtx.restore();
  }
  



let cameraRAF = null;

function drawVideoFrame() {
  if (!mediaStream || video.readyState < 2) return;

  setCanvasSize(video.videoWidth, video.videoHeight);
  imgCtx.drawImage(video, 0, 0, imgCanvas.width, imgCanvas.height);

  cameraRAF = requestAnimationFrame(drawVideoFrame);
}


function clearAll() {
    resetZoom();   // 👈 ADD THIS LINE FIRST
    imgCtx.clearRect(0, 0, imgCanvas.width, imgCanvas.height);
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    currentImage = null;
    lastLandmarks = null;
    imgCtx.clearRect(0, 0, imgCanvas.width, imgCanvas.height);
    chinStrength = 0;
    noseStrength = 0;
    showBefore = false;
    baseImageData = null;
    workingImageData = null;    
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    currentImage = null;
    fileInput.value = "";
  
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }

    if(cameraRAF) {
        cancelAnimationFrame(cameraRAF);
        cameraRAF = null;

    }
    
    captureBtn.disabled = true;
  }

  function drawImageToCanvas(img) {
    // Canvas == image pixels (1:1)
    setCanvasSize(img.naturalWidth, img.naturalHeight);
  
    imgCtx.clearRect(0, 0, imgCanvas.width, imgCanvas.height);
    imgCtx.drawImage(img, 0, 0);
  
    baseImageData = imgCtx.getImageData(
      0, 0, imgCanvas.width, imgCanvas.height
    );
  }
  
  

  function warpImage(displacementFn) {
    const src = workingImageData;
    const dst = imgCtx.createImageData(src.width, src.height);
  
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const { dx, dy } = displacementFn(x, y);
  
        const sx = Math.min(src.width - 1, Math.max(0, x - dx));
        const sy = Math.min(src.height - 1, Math.max(0, y - dy));
  
        const si = (Math.floor(sy) * src.width + Math.floor(sx)) * 4;
        const di = (y * src.width + x) * 4;
  
        dst.data[di]     = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = 255;
      }
    }
  
    imgCtx.putImageData(dst, 0, 0);
  }
   

function drawLandmarks(landmarks) {
    overlayCtx.save();
    overlayCtx.fillStyle = "rgba(0, 255, 180, 0.9)";
    for (const p of landmarks) {
      const x = p.x * overlayCanvas.width;
      const y = p.y * overlayCanvas.height;
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, 1.6, 0, Math.PI * 2);
      overlayCtx.fill();
    }
    overlayCtx.restore();
  }
  

function drawRegion(points, color) {
    if (!points.length) return;
  
    overlayCtx.save();
    overlayCtx.strokeStyle = color;
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.moveTo(points[0].x, points[0].y);
  
    for (let i = 1; i < points.length; i++) {
      overlayCtx.lineTo(points[i].x, points[i].y);
    }
  
    overlayCtx.closePath();
    overlayCtx.stroke();
    overlayCtx.restore();
  }
  


/** ---------- MediaPipe setup ---------- **/
async function initFaceMesh() {
  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });

  faceMesh.onResults((results) => {
    if (currentImage) drawImageToCanvas(currentImage);
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  
    const faces = results.multiFaceLandmarks || [];
    if (!faces.length) return;
  
    const lm = faces[0];
  
    const chinPoints = CHIN_JAW_INDICES.map(i => lmToPoint(lm[i]));
  
    drawLandmarks(lm);
    drawRegion(chinPoints, "rgba(0,255,0,0.9)");
    drawNoseStructure(lm);
  
    // 🔑 Store landmarks
    lastLandmarks = lm;
  
    // 🔑 THIS LINE — add it here, nowhere else
    renderEffects();
  });
  
  
}


async function startCamera() {
    if (mediaStream) return;
  
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
  
      video.srcObject = mediaStream;
      await video.play();
  
      captureBtn.disabled = false;
  
      // Start rendering live camera to canvas
      drawVideoFrame();
  
    } catch (err) {
      alert("Camera access denied or unavailable.");
      console.error(err);
    }
  }
  
  
  async function captureFrame() {
    if (!mediaStream) return;
  
    if (cameraRAF) {
      cancelAnimationFrame(cameraRAF);
      cameraRAF = null;
    }
  
    // Capture frame as base image
    baseImageData = imgCtx.getImageData(
      0, 0, imgCanvas.width, imgCanvas.height
    );
  
    workingImageData = null;
  
    await faceMesh.send({ image: img });

  }
  
  


/** ---------- Run face mesh on uploaded image ---------- **/
async function processUploadedImage(file) {
  if (!faceMesh) await initFaceMesh();

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = async () => {
    currentImage = img;
    drawImageToCanvas(img);

    // MediaPipe expects an HTMLImageElement / video / canvas
    await faceMesh.send({ image: img });
  };
  img.src = URL.createObjectURL(file);
}

/** ---------- Events ---------- **/
fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) return;

  processUploadedImage(file).catch((err) => {
    console.error(err);
    alert("Face processing failed. Try a clearer, front-facing photo.");
  });
});

clearBtn.addEventListener("click", () => {
  clearAll();
});

// Initial
clearAll();

// Existing listeners
startCamBtn.addEventListener("click", startCamera);
captureBtn.addEventListener("click", captureFrame);

// ⬇️ ADD STEP 3 RIGHT AFTER THIS
imgCanvas.addEventListener("wheel", (e) => {
  e.preventDefault();

  const delta = e.deltaY < 0 ? 0.1 : -0.1;
  previewZoom = Math.min(Math.max(1, previewZoom + delta), 2.2);

  applyZoom();
}, { passive: false });

