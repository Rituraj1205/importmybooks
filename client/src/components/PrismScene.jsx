import { useEffect, useRef } from "react";
import * as THREE from "three";

export default function PrismScene({ width = 300, height = 220 }) {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const W = mount.clientWidth || width;
    const H = mount.clientHeight || height;

    const scene = new THREE.Scene();

    // Camera offset slightly right so beam (left) and rays (right) are balanced
    const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
    camera.position.set(0.6, 0.1, 9.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    // ── Lighting ──────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.45));

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
    keyLight.position.set(-5, 4, 6);
    scene.add(keyLight);

    const rimLight = new THREE.PointLight(0x88aaff, 3.5, 25);
    rimLight.position.set(5, -2, 4);
    scene.add(rimLight);

    const tealAccent = new THREE.PointLight(0x0d9488, 1.5, 15);
    tealAccent.position.set(0, 3, 3);
    scene.add(tealAccent);

    // ── Glass Prism ───────────────────────────────────────────
    // Equilateral triangle cross-section, apex pointing up
    const side = 2.6;
    const triH = side * Math.sqrt(3) / 2;

    const triShape = new THREE.Shape();
    triShape.moveTo(0, triH * 2 / 3);           // apex
    triShape.lineTo(-side / 2, -triH / 3);      // bottom-left
    triShape.lineTo(side / 2, -triH / 3);       // bottom-right
    triShape.closePath();

    const prismGeo = new THREE.ExtrudeGeometry(triShape, {
      depth: 1.3,
      bevelEnabled: true,
      bevelSize: 0.045,
      bevelThickness: 0.045,
      bevelSegments: 3,
    });
    prismGeo.center();

    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xc8deff,
      transparent: true,
      opacity: 0.2,
      roughness: 0.0,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });

    const prism = new THREE.Mesh(prismGeo, glassMat);
    prism.rotation.x = 0.1; // slight forward tilt to show depth
    scene.add(prism);

    // Edge wireframe glow — shows the prism shape clearly
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0xaaccff,
      transparent: true,
      opacity: 0.65,
    });
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(prismGeo),
      edgesMat
    );
    edges.rotation.x = 0.1;
    scene.add(edges);

    // Inner face highlight (front face glow for depth)
    const frontFaceMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.04,
      side: THREE.FrontSide,
    });
    const frontFace = new THREE.Mesh(prismGeo, frontFaceMat);
    frontFace.rotation.x = 0.1;
    scene.add(frontFace);

    // ── White Input Beam ──────────────────────────────────────
    // Horizontal beam entering the prism's left face
    // Left face midpoint (apex + bottom-left) / 2 ≈ (-side/4, triH/6) before centering
    // After centering, entry point ≈ (-0.65, 0.35)
    const entryX = -0.65;
    const entryY = 0.38;
    const beamLen = 3.0;

    const addBeam = (r, opacity, col = 0xffffff) => {
      const geo = new THREE.CylinderGeometry(r, r, beamLen, 8);
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.z = -Math.PI / 2;
      // Position: center of beam is beamLen/2 to the left of entry point
      mesh.position.set(entryX - beamLen / 2, entryY, 0.0);
      scene.add(mesh);
      return mesh;
    };

    const beamCore  = addBeam(0.022, 0.92);
    const beamHalo  = addBeam(0.09,  0.14);
    const beamBloom = addBeam(0.22,  0.05);

    // ── Spectrum Rays ─────────────────────────────────────────
    // Exit from right/bottom vertex of prism, fan downward-right
    // Right vertex (bottom-right) after centering ≈ (side/2, -triH/3 + triH/3) = (1.3, 0)
    // But exit visually from the lower-right face area
    const exitX =  0.95;
    const exitY = -0.12;
    const rayLen = 3.6;

    // Physics: red refracts least (topmost), violet most (bottommost)
    const spectrum = [
      { color: 0xff4444, angle:  0.34 }, // red   — least bent (top)
      { color: 0xff8800, angle:  0.20 }, // orange
      { color: 0xffdd00, angle:  0.07 }, // yellow
      { color: 0x44ee66, angle: -0.07 }, // green
      { color: 0x4499ff, angle: -0.20 }, // blue
      { color: 0xaa44ff, angle: -0.34 }, // violet — most bent (bottom)
    ];

    const rayMeshes = [];

    spectrum.forEach(({ color, angle }) => {
      // Direction vector: (cos α, sin α, 0)
      // Cylinder rotation to align Y-axis with direction: rotation.z = angle - π/2
      const rz = angle - Math.PI / 2;
      const cx = exitX + Math.cos(angle) * rayLen / 2;
      const cy = exitY + Math.sin(angle) * rayLen / 2;

      const makeRay = (r, opacity) => {
        const geo = new THREE.CylinderGeometry(r, r, rayLen, 6);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
        const m = new THREE.Mesh(geo, mat);
        m.rotation.z = rz;
        m.position.set(cx, cy, 0);
        scene.add(m);
        return m;
      };

      rayMeshes.push({
        core: makeRay(0.020, 0.9),
        glow: makeRay(0.075, 0.16),
      });
    });

    // ── Background particles (depth/atmosphere) ───────────────
    const pCount = 80;
    const pPos = new Float32Array(pCount * 3);
    for (let i = 0; i < pCount; i++) {
      pPos[i * 3]     = (Math.random() - 0.5) * 10;
      pPos[i * 3 + 1] = (Math.random() - 0.5) * 7;
      pPos[i * 3 + 2] = (Math.random() - 0.5) * 5 - 1;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    scene.add(new THREE.Points(pGeo, new THREE.PointsMaterial({
      color: 0x2dd4bf, size: 0.025, transparent: true, opacity: 0.4,
    })));

    // ── Animation loop ────────────────────────────────────────
    let frameId;
    let t = 0;

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      t += 0.01;

      // Float
      const fy = Math.sin(t * 0.65) * 0.13;
      prism.position.y    = fy;
      edges.position.y    = fy;
      frontFace.position.y = fy;

      // Gentle Y-axis oscillation — shows it's a 3D object
      const yo = Math.sin(t * 0.38) * 0.22;
      prism.rotation.y    = yo;
      edges.rotation.y    = yo;
      frontFace.rotation.y = yo;

      // Beam pulse
      beamCore.material.opacity  = 0.88 + Math.sin(t * 1.6) * 0.07;
      beamHalo.material.opacity  = 0.12 + Math.sin(t * 1.6) * 0.04;
      beamBloom.material.opacity = 0.04 + Math.sin(t * 1.6) * 0.02;

      // Spectrum ray shimmer (staggered per ray)
      rayMeshes.forEach(({ core, glow }, i) => {
        const ph = t * 1.3 + i * 0.26;
        core.material.opacity = 0.84 + Math.sin(ph) * 0.1;
        glow.material.opacity = 0.13 + Math.sin(ph) * 0.04;
      });

      // Rim light breathe
      rimLight.intensity = 3.0 + Math.sin(t * 0.85) * 0.8;

      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", onResize);
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [width, height]);

  return (
    <div
      ref={mountRef}
      style={{ width, height, flexShrink: 0 }}
      aria-hidden="true"
    />
  );
}
