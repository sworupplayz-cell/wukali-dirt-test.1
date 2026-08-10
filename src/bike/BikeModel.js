import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * BikeModel — a low-poly dirt bike built entirely from primitives
 * (no asset loading, ~1.5k triangles, 5 shared materials).
 *
 * Hierarchy:
 *   group (position + full orientation from physics)
 *     chassis (suspension bob)
 *       frame / tank / seat / engine / exhaust / swingarm / rear fender
 *       rearWheel
 *       rake (steering-axis tilt)
 *         steerGroup (rotates with steering)
 *           forks / handlebar / front fender
 *           frontWheel
 */
export class BikeModel {
  constructor(scene) {
    const plastic = new THREE.MeshLambertMaterial({ color: 0xd84315 }); // orange body
    const dark = new THREE.MeshLambertMaterial({ color: 0x24262b });    // tires/seat
    const metal = new THREE.MeshLambertMaterial({ color: 0x9ea6ad });   // forks/engine
    const grey = new THREE.MeshLambertMaterial({ color: 0x51565c });    // frame details
    const hub = new THREE.MeshLambertMaterial({ color: 0xc9cdd1 });

    const g = this.group = new THREE.Group();
    const chassis = this.chassis = new THREE.Group();
    g.add(chassis);

    const box = (w, h, d, mat, x, y, z, rx = 0, rz = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.rotation.x = rx; m.rotation.z = rz;
      chassis.add(m);
      return m;
    };

    // Main frame beam (tank line) + lower frame + engine.
    box(0.16, 0.16, 0.85, grey, 0, 0.78, 0.05, -0.14);
    box(0.14, 0.42, 0.14, grey, 0, 0.55, -0.42, 0.3);
    box(0.30, 0.34, 0.42, metal, 0, 0.46, 0.02);            // engine block
    box(0.26, 0.2, 0.38, plastic, 0, 0.90, 0.16, -0.18);    // fuel tank
    box(0.24, 0.08, 0.62, dark, 0, 0.86, -0.28);            // seat
    box(0.2, 0.05, 0.42, plastic, 0, 0.92, -0.62, 0.28);    // rear fender

    // Exhaust pipe.
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.65, 7), metal);
    exhaust.rotation.x = Math.PI / 2 - 0.15;
    exhaust.position.set(0.14, 0.62, -0.35);
    chassis.add(exhaust);

    // Swingarm to the rear wheel.
    box(0.06, 0.08, 0.55, grey, 0.09, 0.36, -0.4, 0.06);
    box(0.06, 0.08, 0.55, grey, -0.09, 0.36, -0.4, 0.06);

    // Foot pegs.
    box(0.44, 0.04, 0.1, grey, 0, 0.35, -0.05);

    // Wheels.
    this.rearWheel = this._makeWheel(dark, hub);
    this.rearWheel.position.set(0, 0.34, -0.66);
    chassis.add(this.rearWheel);

    // Steering assembly with rake.
    const rake = new THREE.Group();
    rake.position.set(0, 0.94, 0.32);
    rake.rotation.x = -0.42;
    chassis.add(rake);

    const steer = this.steerGroup = new THREE.Group();
    rake.add(steer);

    const forkL = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.72, 6), metal);
    forkL.position.set(0.09, -0.33, 0);
    const forkR = forkL.clone();
    forkR.position.x = -0.09;
    steer.add(forkL, forkR);

    // Handlebar + grips.
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.045, 0.045), grey);
    bar.position.set(0, 0.09, 0);
    steer.add(bar);
    const gripGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.12, 6);
    for (const sx of [-1, 1]) {
      const grip = new THREE.Mesh(gripGeo, dark);
      grip.rotation.z = Math.PI / 2;
      grip.position.set(sx * 0.3, 0.09, 0);
      steer.add(grip);
    }

    // Front fender + number plate.
    const fender = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.5), plastic);
    fender.position.set(0, -0.42, 0.1);
    steer.add(fender);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.03), plastic);
    plate.position.set(0, 0.02, -0.06);
    steer.add(plate);

    this.frontWheel = this._makeWheel(dark, hub);
    this.frontWheel.position.set(0, -0.63, 0.045);
    steer.add(this.frontWheel);

    // Nepali rider: one merged vertex-colored mesh (single draw call),
    // parented to the chassis so position/lean/suspension/jumps are all
    // inherited. Hidden in first person (see setRiderVisible).
    this.rider = new THREE.Mesh(
      buildRiderGeometry(),
      new THREE.MeshLambertMaterial({ vertexColors: true })
    );
    chassis.add(this.rider);

    // Blob shadow (cheap replacement for shadow maps).
    this.shadow = this._makeBlobShadow();
    this._offF = 0; // per-wheel terrain-contact travel (see sync)
    this._offR = 0;

    scene.add(g);
    scene.add(this.shadow);
  }

  _makeWheel(tireMat, hubMat) {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.09, 12), tireMat);
    tire.rotation.z = Math.PI / 2;
    w.add(tire);
    const hubD = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 8), hubMat);
    hubD.rotation.z = Math.PI / 2;
    w.add(hubD);
    // Visible spokes so wheel spin reads clearly.
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.6, 0.035), hubMat);
    const spoke2 = spoke.clone();
    spoke2.rotation.x = Math.PI / 2;
    w.add(spoke, spoke2);
    return w;
  }

  _makeBlobShadow() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    grad.addColorStop(0, 'rgba(0,0,0,0.42)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 2.2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    mesh.renderOrder = 1;
    return mesh; // oriented to the terrain normal every frame in sync()
  }

  /** First person hides the rider so the camera never sits inside him. */
  setRiderVisible(v) {
    this.rider.visible = v;
  }

  /** Copy physics state onto the visual hierarchy. */
  sync(bike, groundY, groundNormal, world, dt = 1 / 60) {
    this.group.position.copy(bike.position);
    if (bike.pivotShift) this.group.position.add(bike.pivotShift);
    this.group.quaternion.copy(bike.quaternion);
    this.chassis.position.y = bike.suspension;

    this.steerGroup.rotation.y = -bike.steer * 0.42;
    this.frontWheel.rotation.x = bike.wheelSpin;
    this.rearWheel.rotation.x = bike.wheelSpin + (bike.slipSpin || 0);

    // ---- Per-wheel terrain contact ----------------------------------------
    // The physics seats the bike's ORIGIN on the terrain with the local
    // normal, but each wheel sits ~0.65 m away where the ground can be
    // higher (tyre buried) or lower (tyre floating). Each wheel therefore
    // samples the terrain under its own column and slides along its real
    // travel axis — the rake/fork axis in front, the chassis vertical in
    // the rear — like true suspension travel. The chassis bob is
    // compensated so the sprung mass bounces while the tyres stay seated.
    if (world) {
      const q = bike.quaternion;
      const suspF = bike.suspension / FORK_AXIS_Y; // bob along the fork axis
      // Neutral (offset-free, bob-compensated) wheel poses first, so world
      // positions below are the reference contact columns.
      this.rearWheel.position.y = REAR_Y - bike.suspension + this._offR;
      this.frontWheel.position.y = FRONT_Y - suspF + this._offF;

      const k = 1 - Math.exp(-45 * dt); // fast wheel travel (tracks the mesh at speed)

      // Contact support: the tyre is a cylinder (radius r, width w). Against
      // the LOCAL RENDERED-SURFACE PLANE with unit normal n and wheel axle
      // a, the center-to-plane contact distance is
      //   s = r * sqrt(1 - (a.n)^2) + (w/2) * |a.n|
      // converted to a vertical gap via s / n.y. Using the plane of the
      // triangle the player actually SEES (not the analytic surface, which
      // deviates between mesh vertices; and not the world vertical, which
      // is wrong on side slopes) is what keeps the tyre visibly seated
      // everywhere; the width term keeps the rim edge out of the ground
      // when the bike leans through corners.
      const seat = (wheel, off, axisWorld, lifted) => {
        wheel.getWorldPosition(_wp);
        if (!bike.grounded || lifted) return off * (1 - k); // relax to neutral in the air / mid-stunt
        if (world.getRenderedPlane) {
          world.getRenderedPlane(_wp.x, _wp.z, _plane);
        } else {
          _plane.y = world.getHeight(_wp.x, _wp.z);
          world.getNormal(_wp.x, _wp.z, _plane.n);
        }
        const n = _plane.n;
        // Actual world axle from the wheel's fresh matrixWorld (column 0):
        // includes steering for the front wheel.
        const e = wheel.matrixWorld.elements;
        _axle.set(e[0], e[1], e[2]).normalize();
        const an = Math.abs(_axle.dot(n));
        const s = WHEEL_R * Math.sqrt(Math.max(0, 1 - an * an)) + HALF_W * an;
        const targetY = _plane.y + s / Math.max(0.55, n.y);
        const dyWorld = targetY - (_wp.y - off * axisWorld.y);
        const t = THREE.MathUtils.clamp(dyWorld / Math.max(0.45, axisWorld.y), -0.28, 0.36);
        return off + (t - off) * k;
      };

      _up.set(0, 1, 0).applyQuaternion(q);                       // rear travel axis
      this._offR = seat(this.rearWheel, this._offR, _up, bike.groundPitch < -0.04);
      this.rearWheel.position.y = REAR_Y - bike.suspension + this._offR;

      _fork.set(0, FORK_AXIS_Y, FORK_AXIS_Z).applyQuaternion(q); // front travel axis
      this._offF = seat(this.frontWheel, this._offF, _fork, bike.groundPitch > 0.04);
      this.frontWheel.position.y = FRONT_Y - suspF + this._offF;
    }

    // Blob shadow hugs the RENDERED terrain (the visible triangle plane —
    // the analytic surface can sit below it) and fades with height.
    let sy = groundY, sn = groundNormal;
    if (world && world.getRenderedPlane) {
      world.getRenderedPlane(bike.position.x, bike.position.z, _plane);
      sy = _plane.y; sn = _plane.n;
    }
    this.shadow.position.set(
      bike.position.x + sn.x * 0.08,
      sy + sn.y * 0.08,
      bike.position.z + sn.z * 0.08
    );
    this.shadow.quaternion.setFromUnitVectors(_planeUp, sn);
    const h = Math.max(0, bike.heightAboveGround);
    const f = Math.max(0.25, 1 - h * 0.18);
    this.shadow.scale.setScalar(f);
    this.shadow.material.opacity = f;
  }
}

const _planeUp = new THREE.Vector3(0, 0, 1); // PlaneGeometry faces +Z
// Wheel-contact geometry (matches the constructor's local poses above).
const WHEEL_R = 0.34;
const HALF_W = 0.045;       // half tyre width (cylinder height 0.09)
const REAR_Y = 0.34;        // rear wheel base local y (chassis space)
const FRONT_Y = -0.63;      // front wheel base local y (steer space)
const FORK_AXIS_Y = Math.cos(0.42);  // rake axis in chassis space
const FORK_AXIS_Z = -Math.sin(0.42);
const _up = new THREE.Vector3();
const _fork = new THREE.Vector3();
const _axle = new THREE.Vector3();
const _wp = new THREE.Vector3();
const _plane = { y: 0, n: new THREE.Vector3(0, 1, 0) }; // rendered-surface plane

/**
 * Low-poly rider in a fictional Nepali-inspired outfit: cream daura shirt
 * and suruwal trousers, charcoal vest, Dhaka-style topi (cream with a rust
 * band), seated riding pose reaching the handlebars. ~200 triangles, all
 * in one merged vertex-colored geometry.
 */
function buildRiderGeometry() {
  const parts = [];
  const add = (geo, r, g, b, tf) => {
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    geo.deleteAttribute('uv');
    if (tf) tf(geo);
    parts.push(geo);
  };
  const CREAM = [0.88, 0.84, 0.72], VEST = [0.23, 0.21, 0.26];
  const SKIN = [0.72, 0.55, 0.40], DARK = [0.16, 0.14, 0.13], RUST = [0.62, 0.26, 0.20];

  // Pelvis on the seat, torso leaning toward the bars.
  add(new THREE.BoxGeometry(0.27, 0.18, 0.3), ...CREAM, (g) => g.translate(0, 0.98, -0.3));
  add(new THREE.BoxGeometry(0.34, 0.48, 0.24), ...VEST, (g) => g.rotateX(0.3).translate(0, 1.27, -0.17));
  add(new THREE.BoxGeometry(0.36, 0.1, 0.26), ...CREAM, (g) => g.rotateX(0.3).translate(0, 1.05, -0.24)); // daura hem
  // Neck + head + Dhaka topi.
  add(new THREE.BoxGeometry(0.09, 0.09, 0.09), ...SKIN, (g) => g.translate(0, 1.52, -0.1));
  add(new THREE.BoxGeometry(0.18, 0.2, 0.19), ...SKIN, (g) => g.translate(0, 1.66, -0.08));
  add(new THREE.CylinderGeometry(0.105, 0.118, 0.06, 8), ...RUST, (g) => g.rotateX(-0.12).translate(0, 1.79, -0.09));
  add(new THREE.CylinderGeometry(0.082, 0.104, 0.09, 8), ...CREAM, (g) => g.rotateX(-0.12).translate(0, 1.86, -0.1));
  // Arms reaching the handlebars (cream daura sleeves, skin hands).
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.09, 0.3, 0.1), ...VEST,
      (g) => g.rotateX(0.9).rotateZ(sx * -0.22).translate(sx * 0.21, 1.33, 0.02));
    add(new THREE.BoxGeometry(0.08, 0.3, 0.08), ...CREAM,
      (g) => g.rotateX(1.15).rotateZ(sx * -0.12).translate(sx * 0.27, 1.16, 0.24));
    add(new THREE.BoxGeometry(0.07, 0.09, 0.1), ...SKIN, (g) => g.translate(sx * 0.3, 1.08, 0.37));
    // Suruwal thighs + shins, shoes on the pegs.
    add(new THREE.BoxGeometry(0.12, 0.36, 0.14), ...CREAM,
      (g) => g.rotateX(1.25).rotateZ(sx * -0.15).translate(sx * 0.13, 0.87, -0.1));
    add(new THREE.BoxGeometry(0.1, 0.34, 0.11), ...CREAM,
      (g) => g.rotateX(0.25).translate(sx * 0.2, 0.58, 0.02));
    add(new THREE.BoxGeometry(0.09, 0.08, 0.22), ...DARK, (g) => g.translate(sx * 0.2, 0.38, 0.0));
  }
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const merged = mergeGeometries(flat);
  parts.forEach((p) => p.dispose());
  flat.forEach((p) => p.dispose());
  return merged;
}