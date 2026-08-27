import { useEffect, useRef } from "react";
import * as THREE from "three";

export default function KalkiChakra({ size = 300 }) {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const W = mount.clientWidth || size;
    const H = mount.clientHeight || size;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, W / H, 0.1, 100);
    camera.position.set(0, 0, 6);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    const tealLight = new THREE.PointLight(0x0d9488, 6, 30);
    tealLight.position.set(0, 0, 4);
    scene.add(tealLight);

    const amberLight = new THREE.PointLight(0xf59e0b, 3, 25);
    amberLight.position.set(3, 2, 3);
    scene.add(amberLight);

    const backLight = new THREE.PointLight(0x0891b2, 2, 20);
    backLight.position.set(-2, -2, -2);
    scene.add(backLight);

    // ── Chakra Group ──────────────────────────────────────────
    const chakra = new THREE.Group();
    scene.add(chakra);

    // Outer decorative ring
    const outerRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.0, 0.07, 20, 80),
      new THREE.MeshStandardMaterial({
        color: 0x2dd4bf, emissive: 0x0d9488, emissiveIntensity: 1.2,
        metalness: 0.95, roughness: 0.05,
      })
    );
    chakra.add(outerRing);

    // Mid decorative ring
    const midRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.55, 0.04, 16, 60),
      new THREE.MeshStandardMaterial({
        color: 0xfbbf24, emissive: 0xf59e0b, emissiveIntensity: 0.8,
        metalness: 0.9, roughness: 0.1,
      })
    );
    chakra.add(midRing);

    // Inner ring
    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.85, 0.05, 16, 48),
      new THREE.MeshStandardMaterial({
        color: 0x2dd4bf, emissive: 0x0d9488, emissiveIntensity: 1.0,
        metalness: 0.9, roughness: 0.05,
      })
    );
    chakra.add(innerRing);

    // Spokes (16 thin bars from inner to outer)
    const spokeMat = new THREE.MeshStandardMaterial({
      color: 0xe0f2fe, emissive: 0x7dd3fc, emissiveIntensity: 0.4,
      metalness: 0.8, roughness: 0.2,
    });
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.055, 1.1, 0.045), spokeMat);
      spoke.position.set(Math.sin(angle) * 1.425, Math.cos(angle) * 1.425, 0);
      spoke.rotation.z = angle;
      chakra.add(spoke);
    }

    // Outer blades (8 triangular sword tips)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(-0.14, 0.42);
      shape.lineTo(0, 0.55);
      shape.lineTo(0.14, 0.42);
      shape.closePath();
      const blade = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({
          color: 0xfbbf24, emissive: 0xf59e0b, emissiveIntensity: 0.7,
          metalness: 0.85, roughness: 0.15, side: THREE.DoubleSide,
        })
      );
      blade.position.set(Math.sin(angle) * 1.72, Math.cos(angle) * 1.72, 0);
      blade.rotation.z = -angle + Math.PI;
      chakra.add(blade);
    }

    // Between-blade small teal triangles (8 more, offset 22.5°)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(-0.07, 0.28);
      shape.lineTo(0.07, 0.28);
      shape.closePath();
      const mini = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({
          color: 0x2dd4bf, emissive: 0x0d9488, emissiveIntensity: 0.8,
          metalness: 0.8, roughness: 0.2, side: THREE.DoubleSide,
        })
      );
      mini.position.set(Math.sin(angle) * 1.72, Math.cos(angle) * 1.72, 0);
      mini.rotation.z = -angle + Math.PI;
      chakra.add(mini);
    }

    // Center orb
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 32, 32),
      new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0x0d9488, emissiveIntensity: 2.5,
        metalness: 1, roughness: 0,
      })
    );
    chakra.add(orb);

    // Center ring detail (tiny torus around orb)
    chakra.add(new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.03, 12, 32),
      new THREE.MeshStandardMaterial({
        color: 0xfbbf24, emissive: 0xfbbf24, emissiveIntensity: 1.5,
        metalness: 1, roughness: 0,
      })
    ));

    // ── Orbital Particles ──────────────────────────────────────
    const particleCount = 200;
    const pPositions = new Float32Array(particleCount * 3);
    const pAngles = new Float32Array(particleCount);
    const pRadii = new Float32Array(particleCount);
    const pSpeeds = new Float32Array(particleCount);
    const pZ = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i++) {
      pAngles[i] = Math.random() * Math.PI * 2;
      pRadii[i] = 1.9 + (Math.random() - 0.5) * 0.6;
      pSpeeds[i] = 0.003 + Math.random() * 0.006;
      pZ[i] = (Math.random() - 0.5) * 0.5;
      pPositions[i * 3] = Math.cos(pAngles[i]) * pRadii[i];
      pPositions[i * 3 + 1] = Math.sin(pAngles[i]) * pRadii[i];
      pPositions[i * 3 + 2] = pZ[i];
    }

    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute("position", new THREE.BufferAttribute(pPositions, 3));

    const particleMat = new THREE.PointsMaterial({
      color: 0x5eead4,
      size: 0.045,
      transparent: true,
      opacity: 0.75,
      sizeAttenuation: true,
    });
    const particleMesh = new THREE.Points(particleGeo, particleMat);
    scene.add(particleMesh);

    // ── Animation ─────────────────────────────────────────────
    let frameId;
    let t = 0;

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      t += 0.012;

      // Spin chakra
      chakra.rotation.z += 0.006;

      // Float
      chakra.position.y = Math.sin(t * 0.7) * 0.18;

      // Gentle 3D tilt
      chakra.rotation.x = Math.sin(t * 0.35) * 0.1;
      chakra.rotation.y = Math.sin(t * 0.28) * 0.08;

      // Orb pulse
      const pulse = 1 + Math.sin(t * 2.5) * 0.08;
      orb.scale.setScalar(pulse);

      // Light pulse
      tealLight.intensity = 5.5 + Math.sin(t * 2) * 1.5;
      amberLight.intensity = 2.5 + Math.sin(t * 1.5 + 1) * 0.8;

      // Orbital particle movement
      const pos = particleGeo.attributes.position;
      for (let i = 0; i < particleCount; i++) {
        pAngles[i] += pSpeeds[i];
        pos.setX(i, Math.cos(pAngles[i]) * pRadii[i]);
        pos.setY(i, Math.sin(pAngles[i]) * pRadii[i]);
      }
      pos.needsUpdate = true;

      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!mount) return;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", onResize);
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [size]);

  return (
    <div
      ref={mountRef}
      style={{ width: size, height: size, flexShrink: 0 }}
      aria-hidden="true"
    />
  );
}
