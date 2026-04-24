/**
 * Momo Nails — Procreate 3D Viewer Module
 * =========================================
 * Parses .procreate files (ZIP archive), extracts layer images,
 * composites them on a canvas, and renders the result as a
 * texture on an interactive 3D nail model using Three.js.
 *
 * Dependencies loaded dynamically:
 *   - JSZip  (layer extraction)
 *   - Three.js + OrbitControls (3D rendering)
 */

(function () {
  'use strict';

  // ─── CDN URLs ───────────────────────────────────────────────────────────────
  const JSZIP_CDN     = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  const THREE_CDN     = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  const ORBIT_CDN     = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js';

  // ─── State ──────────────────────────────────────────────────────────────────
  let threeScene, threeCamera, threeRenderer, orbitControls, nailMesh;
  let animFrameId = null;

  // ─── Utility: load script dynamically ───────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ─── Utility: show toast ─────────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    const toast = document.getElementById('pv-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `pv-toast pv-toast--${type} pv-toast--visible`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('pv-toast--visible'), 3500);
  }

  // ─── Build the Nail geometry (elongated ellipsoid + curve) ───────────────────
  function buildNailGeometry() {
    // Create a shape that resembles a fingernail viewed from above
    const shape = new THREE.Shape();
    // Nail outline — rounded rectangle tapering at the cuticle end
    const w = 1.0, h = 1.4;
    shape.moveTo(-w / 2, -h / 2);
    shape.lineTo(-w / 2,  h / 2 - w / 2);
    shape.quadraticCurveTo(-w / 2, h / 2,  0, h / 2); // top-left arc
    shape.quadraticCurveTo( w / 2, h / 2,  w / 2, h / 2 - w / 2); // top-right arc
    shape.lineTo( w / 2, -h / 2);
    // Cuticle (bottom) subtle arc
    shape.quadraticCurveTo(w / 4, -h / 2 - 0.15, 0, -h / 2 - 0.15);
    shape.quadraticCurveTo(-w / 4, -h / 2 - 0.15, -w / 2, -h / 2);

    const extrudeSettings = {
      depth: 0.08,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.04,
      bevelSegments: 6,
      curveSegments: 32,
    };

    const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);

    // Compute UVs so the texture maps onto the face nicely
    geo.computeBoundingBox();
    const bbox = geo.boundingBox;
    const uvAttr = geo.attributes.uv;
    const posAttr = geo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const u = (x - bbox.min.x) / (bbox.max.x - bbox.min.x);
      const v = (y - bbox.min.y) / (bbox.max.y - bbox.min.y);
      uvAttr.setXY(i, u, v);
    }
    uvAttr.needsUpdate = true;

    return geo;
  }

  // ─── Init Three.js scene ─────────────────────────────────────────────────────
  function initScene(canvas) {
    const W = canvas.clientWidth  || 600;
    const H = canvas.clientHeight || 420;

    threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color(0x0f0f0f);

    // Camera
    threeCamera = new THREE.PerspectiveCamera(45, W / H, 0.01, 100);
    threeCamera.position.set(0, 0, 3.5);

    // Renderer
    threeRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    threeRenderer.setPixelRatio(window.devicePixelRatio);
    threeRenderer.setSize(W, H);
    threeRenderer.shadowMap.enabled = true;

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    threeScene.add(ambient);

    const key = new THREE.DirectionalLight(0xffd4a3, 1.4);
    key.position.set(2, 3, 4);
    key.castShadow = true;
    threeScene.add(key);

    const fill = new THREE.DirectionalLight(0xc8a4d4, 0.6);
    fill.position.set(-3, -1, 2);
    threeScene.add(fill);

    const rim = new THREE.DirectionalLight(0xffb7c5, 0.8);
    rim.position.set(0, -4, -3);
    threeScene.add(rim);

    // Environment cube for reflections
    const pmrem = new THREE.PMREMGenerator(threeRenderer);
    const envTex = pmrem.fromScene(new THREE.RoomEnvironment()).texture;
    threeScene.environment = envTex;

    // OrbitControls
    orbitControls = new THREE.OrbitControls(threeCamera, threeRenderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.07;
    orbitControls.minDistance = 1.5;
    orbitControls.maxDistance = 8;
    orbitControls.autoRotate = true;
    orbitControls.autoRotateSpeed = 1.2;

    // Resize observer
    const ro = new ResizeObserver(() => {
      const w2 = canvas.clientWidth;
      const h2 = canvas.clientHeight;
      threeCamera.aspect = w2 / h2;
      threeCamera.updateProjectionMatrix();
      threeRenderer.setSize(w2, h2);
    });
    ro.observe(canvas.parentElement);
  }

  // ─── Build / update nail mesh with texture ───────────────────────────────────
  function buildNailMesh(texture) {
    if (nailMesh) {
      threeScene.remove(nailMesh);
      nailMesh.geometry.dispose();
      nailMesh.material.dispose();
    }

    texture.flipY = false;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;

    const geo  = buildNailGeometry();
    const mat  = new THREE.MeshPhysicalMaterial({
      map: texture,
      roughness: 0.12,
      metalness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      reflectivity: 0.9,
      side: THREE.FrontSide,
    });

    nailMesh = new THREE.Mesh(geo, mat);
    nailMesh.rotation.x = -0.2;
    nailMesh.castShadow = true;
    threeScene.add(nailMesh);
  }

  // ─── Render loop ─────────────────────────────────────────────────────────────
  function startRenderLoop() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    function tick() {
      animFrameId = requestAnimationFrame(tick);
      orbitControls.update();
      threeRenderer.render(threeScene, threeCamera);
    }
    tick();
  }

  // ─── Parse .procreate ZIP and composite layers ───────────────────────────────
  async function parseProcreate(file) {
    const JSZip = window.JSZip;
    if (!JSZip) throw new Error('JSZip no disponible');

    const zip = await JSZip.loadAsync(file);

    // Collect PNG layer files (they live at the root or in subfolders named with UUIDs)
    const pngEntries = [];
    zip.forEach((relativePath, entry) => {
      if (!entry.dir && /\.(png)$/i.test(relativePath)) {
        pngEntries.push(entry);
      }
    });

    if (pngEntries.length === 0) {
      throw new Error('No se encontraron capas de imagen en el archivo.');
    }

    // Sort: Procreate stores layers as UUID-named PNGs.
    // Without the plist we can't know opacity/blend mode, so we composite all visible ones.
    pngEntries.sort((a, b) => a.name.localeCompare(b.name));

    // Load all layer blobs as ImageBitmaps
    const bitmaps = [];
    for (const entry of pngEntries) {
      try {
        const blob = await entry.async('blob');
        const bmp  = await createImageBitmap(blob);
        bitmaps.push(bmp);
      } catch (e) {
        console.warn(`[ProcreateViewer] Skipping layer ${entry.name}:`, e);
      }
    }

    if (bitmaps.length === 0) throw new Error('No se pudieron cargar las imágenes de capas.');

    // Composite on a canvas (bottom to top, normal blend)
    const W = bitmaps[0].width;
    const H = bitmaps[0].height;
    const offscreen = new OffscreenCanvas(W, H);
    const ctx = offscreen.getContext('2d');

    for (const bmp of bitmaps) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(bmp, 0, 0, W, H);
      bmp.close();
    }

    // Convert to ImageBitmap for Three.js
    const compositeBmp = await offscreen.transferToImageBitmap();
    return compositeBmp;
  }

  // ─── Main entry: handle file upload ──────────────────────────────────────────
  async function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'procreate') {
      showToast('Por favor sube un archivo .procreate válido', 'error');
      return;
    }

    const loader = document.getElementById('pv-loader');
    const canvas = document.getElementById('pv-canvas');
    const placeholder = document.getElementById('pv-placeholder');

    if (loader) loader.style.display = 'flex';
    if (placeholder) placeholder.style.display = 'none';

    try {
      showToast(`Procesando "${file.name}"…`, 'info');

      const bitmap = await parseProcreate(file);

      // Init scene on first use
      if (!threeRenderer) {
        initScene(canvas);
        startRenderLoop();
      }

      const texture = new THREE.CanvasTexture(bitmap);
      buildNailMesh(texture);

      if (canvas) canvas.style.display = 'block';

      // Update file info UI
      const info = document.getElementById('pv-file-info');
      if (info) {
        info.textContent = `📁 ${file.name}  ·  ${(file.size / 1024).toFixed(1)} KB`;
        info.style.display = 'block';
      }

      showToast('¡Modelo cargado! Arrastra para rotar, scroll para zoom.', 'success');
    } catch (err) {
      console.error('[ProcreateViewer]', err);
      showToast(`Error: ${err.message}`, 'error');
      if (placeholder) placeholder.style.display = 'flex';
    } finally {
      if (loader) loader.style.display = 'none';
    }
  }

  // ─── Toggle auto-rotate ───────────────────────────────────────────────────────
  window.pvToggleAutoRotate = function () {
    if (!orbitControls) return;
    orbitControls.autoRotate = !orbitControls.autoRotate;
    const btn = document.getElementById('pv-btn-rotate');
    if (btn) btn.innerHTML = orbitControls.autoRotate
      ? '<i class="fas fa-pause"></i> Pausar rotación'
      : '<i class="fas fa-play"></i> Rotar';
  };

  // ─── Reset camera ─────────────────────────────────────────────────────────────
  window.pvResetCamera = function () {
    if (!threeCamera || !orbitControls) return;
    threeCamera.position.set(0, 0, 3.5);
    orbitControls.target.set(0, 0, 0);
    orbitControls.update();
  };

  // ─── Toggle wireframe ─────────────────────────────────────────────────────────
  window.pvToggleWireframe = function () {
    if (!nailMesh) return;
    nailMesh.material.wireframe = !nailMesh.material.wireframe;
    const btn = document.getElementById('pv-btn-wire');
    if (btn) btn.innerHTML = nailMesh.material.wireframe
      ? '<i class="fas fa-fill-drip"></i> Sólido'
      : '<i class="fas fa-border-all"></i> Wireframe';
  };

  // ─── Bootstrap ───────────────────────────────────────────────────────────────
  async function bootstrap() {
    try {
      await loadScript(JSZIP_CDN);
      await loadScript(THREE_CDN);
      await loadScript(ORBIT_CDN);
    } catch (e) {
      console.error('[ProcreateViewer] Failed to load dependencies:', e);
      showToast('Error cargando librerías 3D. Verifica tu conexión.', 'error');
      return;
    }

    // ─ Drop Zone ───────────────────────────────────────────────────────────────
    const dropZone = document.getElementById('pv-dropzone');
    const fileInput = document.getElementById('pv-file-input');

    if (!dropZone || !fileInput) return;

    dropZone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) handleFile(fileInput.files[0]);
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('pv-dropzone--active');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('pv-dropzone--active');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('pv-dropzone--active');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
