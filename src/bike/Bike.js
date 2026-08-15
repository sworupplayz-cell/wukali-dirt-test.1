import * as THREE from 'three';

/**
 * Bike — arcade dirt-bike physics on a heightfield.
 *
 * Deliberately NOT a rigid-body motorcycle simulation: a scalar forward
 * speed + heading + heightfield contact model is stable, cheap and
 * predictable on low-end phones. The bike only talks to the world through
 * the sampling interface (getHeight/getNormal/getColliders), so a future
 * procedural chunk world can be swapped in without touching this file.
 */

const G = 18;                 // arcade gravity (m/s^2)
const MAX_SPEED = 26;         // ~94 km/h — engine-limited top speed
const MAX_DOWNHILL = 34;      // ~122 km/h — gravity may push past the engine cap
const OVERSPEED_DRAG = 1.6;   // 1/s bleed above MAX_SPEED (smooth, no clamp snap)
const MAX_REVERSE = -4.5;
const ACCEL = 11;
const BRAKE_DECEL = 17;
const REVERSE_ACCEL = 4.5;
const WHEELBASE = 1.35;
const MAX_GROUND_SLOPE = 1.0;  // steepest rise (45°) ground-following may climb
const CRASH_LAND_VY = -12.0;  // downward speed + bad pitch => crash
const CRASH_LAND_PITCH = 0.9;
const CRASH_HIT_SPEED = 10;   // head-on prop hit above this => crash

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qLean = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const _axisZ = new THREE.Vector3(0, 0, 1);
const _axisX = new THREE.Vector3(1, 0, 0);

export class Bike {
  constructor(world) {
    this.world = world;

    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3(); // used while airborne
    this.forward = new THREE.Vector3(0, 0, 1);
    this.groundNormal = new THREE.Vector3(0, 1, 0);

    this.yaw = 0;
    this.speed = 0;          // signed scalar, along forward, while grounded
    this.steer = 0;          // smoothed steering [-1, 1]
    this.roll = 0;           // lean, rad
    this.airPitch = 0;       // extra pitch while airborne, rad
    this.airPitchTravel = 0; // signed pitch rotation accumulated this flight
    this.groundPitch = 0;    // wheelie (+) / endo (-) pitch while grounded
    this.pivotShift = new THREE.Vector3(); // model shift: pitch about the contact wheel
    this._trickVel = 0;      // TRICK button spin velocity (momentum, rad/s)
    this.crashRoll = 0;      // tip-over animation when crashed
    this.grounded = true;
    this.crashed = false;
    this.crashTimer = 0;
    this.wheelSpin = 0;
    this.slipSpin = 0;       // extra rear-wheel spin when traction breaks (visual)
    this.slip = 0;           // 0..1 rear-wheel slip fraction
    this.surface = { grip: 1, drag: 0, rough: 0 }; // material under the wheels
    this._surfTimer = 0;
    this._bumpPhase = 0;
    this.suspension = 0;     // visual spring value
    this._suspVel = 0;
    this._brakeEff = 0;      // smoothed brake force (SP-1: no grab on tap)
    this._stillT = 0;        // time at standstill with brake held (reverse delay)
    this.weightPitch = 0;    // accel squat / brake dive (SP-1, orientation only)
    this._safeTimer = 0;
    this._safe = { x: 0, y: 0, z: 0, yaw: 0 };
    this.heightAboveGround = 0;

    this.onCrash = null;     // event hook (Game listens; no polling)

    this.fullReset();
  }

  /** Back to spawn (used by PLAY / RESTART). */
  fullReset() {
    const s = this.world.getSpawn();
    this._placeAt(s.x, s.y, s.z, s.yaw);
    this._safe = { x: s.x, y: s.y, z: s.z, yaw: s.yaw };
  }

  /** Back to last safe position (R key / reset button / after crash). */
  reset() {
    const s = this._safe;
    this._placeAt(s.x, this.world.getHeight(s.x, s.z), s.z, s.yaw);
  }

  _placeAt(x, y, z, yaw) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.speed = 0;
    this.steer = 0;
    this.roll = 0;
    this.airPitch = 0;
    this.airPitchTravel = 0;
    this.groundPitch = 0;
    this.pivotShift.set(0, 0, 0);
    this._trickVel = 0;
    this.crashRoll = 0;
    this.grounded = true;
    this.crashed = false;
    this.crashTimer = 0;
    this.suspension = 0;
    this._suspVel = 0;
    this._brakeEff = 0;
    this._stillT = 0;
    this.weightPitch = 0;
    this._safeTimer = 0;
    this.slip = 0;
    this.surface.grip = 1; this.surface.drag = 0; this.surface.rough = 0;
    this._surfTimer = 0;
    this.groundNormal.set(0, 1, 0);
    this._updateOrientation(1 / 60);
  }

  _crash() {
    if (this.crashed) return;
    this.crashed = true;
    this.crashTimer = 0;
    if (this.onCrash) this.onCrash();
  }

  /** Fixed-timestep update. input: { throttle, brake, steer } each frame. */
  update(dt, input) {
    const world = this.world;
    const throttle = this.crashed ? 0 : input.throttle;
    const brake = this.crashed ? 0 : input.brake;
    const steerIn = this.crashed ? 0 : input.steer;
    const stunt = this.crashed ? 0 : (input.stunt || 0);
    const trick = this.crashed ? 0 : (input.trick || 0);

    // Smooth the steering input so touch taps don't snap the bike.
    // (Phase 2 feel: slightly quicker attack, so the bike answers the bar
    // on rolling terrain without becoming twitchy.)
    this.steer += (steerIn - this.steer) * Math.min(1, 12 * dt);

    // Refresh the surface material under the wheels at ~20 Hz (one cheap
    // analytic mask sample — the bike's only extra terrain query).
    this._surfTimer -= dt;
    if (this._surfTimer <= 0 && world.getSurface) {
      this._surfTimer = 0.05;
      world.getSurface(this.position.x, this.position.z, this.surface);
    }

    if (this.grounded) {
      this._groundStep(dt, throttle, brake, stunt);
    } else {
      this._airStep(dt, throttle, brake, stunt, trick);
    }

    if (this.crashed) {
      this.crashTimer += dt;
      // Tip over and grind to a stop.
      this.crashRoll += (Math.PI / 2.1 - this.crashRoll) * Math.min(1, 5 * dt);
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 14 * dt);
    }

    this._collideProps();
    this._recordSafePosition(dt);
    this._updateSuspension(dt);
    this._updateOrientation(dt);

    this.wheelSpin += (this.speed / 0.34) * dt;
    this.slipSpin += this.slip * 55 * dt; // extra rear-wheel spin while traction breaks
    this.heightAboveGround = this.position.y - world.getHeight(this.position.x, this.position.z);
    if (!Number.isFinite(this.speed)) this.speed = 0; // physics-explosion failsafe
    if (!Number.isFinite(this.position.y)) this.reset();

    // Out of the test area: snap back to safety (Phase 2 world removes this).
    if (!world.isInBounds(this.position.x, this.position.z) || this.position.y < -30) {
      this.reset();
    }
  }

  _groundStep(dt, throttle, brake, stunt = 0) {
    // Forward on the ground plane.
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const n = this.groundNormal;
    _v1.copy(this.forward).addScaledVector(n, -this.forward.dot(n)).normalize();

    // Speed: throttle tapers near max, brake reverses slowly, drag otherwise.
    // Drive force is traction-limited twice over: grip fades on steep faces
    // (walls can only be rushed on momentum, never powered up) and loose
    // surfaces — grass, rock, wet stream stones — put down less power than
    // the groomed road. Roads/moderate slopes keep full grip.
    const climb = Math.max(0, _v1.y);
    const slopeGrip = 1 - 0.75 * Math.min(1, Math.max(0, (climb - 0.55) / 0.3));
    const grip = slopeGrip * this.surface.grip;
    this.slip = 0;
    // SP-1: brake force ramps in over ~0.1 s so a tap slows instead of
    // grabbing; reverse needs a deliberate ~0.35 s hold through the final
    // skid (no more surprise backward creep when stopping hard, but wedge
    // recovery stays quick). Phase 2: slightly faster bite for trail feel.
    this._brakeEff += (brake - this._brakeEff) * Math.min(1, 11 * dt);
    if (Math.abs(this.speed) < 1.5 && brake > 0) this._stillT += dt;
    else this._stillT = 0;
    if (throttle > 0) {
      // SP-1 torque curve: fuller midrange pull, same top speed — the
      // linear taper left the bike breathless between 15 and 25 m/s.
      // Exponent 1.25 keeps casual off-road cruising near the old pace.
      const vN = Math.max(this.speed, 0) / MAX_SPEED;
      this.speed += ACCEL * grip * Math.max(0, 1 - Math.pow(vN, 1.25)) * throttle * dt;
      this.slip = throttle * (1 - Math.min(1, grip)); // rear wheel overspin (visual)
    } else if (brake > 0) {
      // Braking bites a little softer on loose/wet ground.
      const bite = 0.7 + 0.3 * this.surface.grip;
      if (this.speed > 0.3) this.speed -= BRAKE_DECEL * bite * this._brakeEff * dt;
      else if (this._stillT > 0.35 || this.speed < -0.3) {
        this.speed = Math.max(this.speed - REVERSE_ACCEL * brake * dt, MAX_REVERSE);
      } else {
        this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), BRAKE_DECEL * dt);
      }
    } else {
      // Coast: engine braking + rolling friction. The proportional decay
      // fades out on real descents so gravity can pull the bike downhill
      // naturally — flat-ground roll-out behaviour is unchanged.
      const eb = 0.5 * (1 - Math.min(1, Math.max(0, -_v1.y) * 2.5));
      this.speed *= 1 - Math.min(1, eb * dt);
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 0.8 * dt);
    }
    // Rolling resistance of the surface itself (roads free-roll; grass,
    // rocks and stream beds scrub speed — off-road shortcuts still work,
    // they just can't hold road top speed).
    this.speed -= this.surface.drag * this.speed * dt;
    // Slope resistance/assist along travel direction (full gravity: what
    // momentum buys on a steep face, gravity takes back honestly).
    this.speed -= G * _v1.y * dt;
    // Near-wall scrub: beyond ~40 deg the tyres shear out and momentum
    // dies fast — a full-speed rush clears at most a ~3 m step, never a
    // 10 m face. (Sustained climbing already caps near 33 deg via grip.)
    if (climb > 0.65) this.speed -= this.speed * Math.min(1, (climb - 0.65) * 18 * dt);
    // Downhill overspeed: gravity may carry the bike past the engine cap,
    // and drag reels it back smoothly once the grade eases — no hard-clamp
    // speed snaps in either direction.
    if (this.speed > MAX_SPEED) {
      this.speed -= (this.speed - MAX_SPEED) * OVERSPEED_DRAG * dt;
    }
    this.speed = Math.max(MAX_REVERSE, Math.min(MAX_DOWNHILL, this.speed));

    // Steering: fades in with speed, tightens down at high speed, loosens
    // slightly on low-grip surfaces (kept subtle — fun over simulation).
    // STUNT: the rider actively works the bike — cornering bites harder.
    const turnFactor =
      Math.max(-1, Math.min(1, this.speed / 4)) / (1 + Math.abs(this.speed) * 0.03);
    this.yaw -= this.steer * 2.1 * turnFactor * (0.72 + 0.28 * this.surface.grip) *
      (1 + 0.25 * stunt) * dt;

    // Terrain texture: rough ground rattles the suspension and nudges the
    // heading a touch at speed. Deterministic incommensurate oscillators —
    // no noise samples, no allocations, purely a feel layer.
    const sp = Math.abs(this.speed);
    if (sp > 2) {
      this._bumpPhase += sp * dt * 1.9;
      const excite = this.surface.rough * Math.min(1, sp / 9);
      this._suspVel +=
        (Math.sin(this._bumpPhase) * 0.62 + Math.sin(this._bumpPhase * 2.37 + 1.3) * 0.38) *
        excite * 30 * dt;
      // STUNT also steadies the bike: rough-ground heading wander halves.
      this.yaw += Math.sin(this._bumpPhase * 0.53 + 0.7) * excite * 0.05 * (1 - 0.5 * stunt) * dt;
    }

    // Move along the slope.
    const prevY = this.position.y;
    this.position.x += _v1.x * this.speed * dt;
    this.position.z += _v1.z * this.speed * dt;
    const vy = _v1.y * this.speed;

    const groundY = this.world.getHeight(this.position.x, this.position.z);
    const predictedY = prevY + (vy - G * dt) * dt;

    if (predictedY > groundY + 0.06 && !this.crashed) {
      // Ground fell away faster than gravity: takeoff. A compressed
      // suspension at the lip adds a small rebound pop.
      this.grounded = false;
      this.velocity.copy(_v1).multiplyScalar(this.speed);
      this.velocity.y = Math.min(vy, 11) + Math.max(0, -this.suspension) * 3;
      this.position.y = prevY + vy * dt;
      this.slip = 0;
      this.airPitchTravel = 0;
      this._trickVel = 0;
    } else {
      const rise = groundY - prevY;
      const horiz = Math.abs(this.speed) * dt + 1e-6;
      if (rise > horiz * MAX_GROUND_SLOPE + 0.03) {
        // The terrain rises faster than any wheel could follow: that's a
        // wall, not a slope. Stay below the face and thud off it instead
        // of snapping upward onto higher ground.
        this.position.x -= _v1.x * this.speed * dt;
        this.position.z -= _v1.z * this.speed * dt;
        this.position.y = this.world.getHeight(this.position.x, this.position.z);
        this.speed *= 0.2;
        this._suspVel -= 2;
      } else {
        this.position.y = groundY;
        this._suspVel += THREE.MathUtils.clamp(rise * 6 - vy * 0.15, -3, 3) * dt * 12;
      }
    }

    // Lean into turns (deeper while STUNT is held — active body control).
    const targetRoll = THREE.MathUtils.clamp(
      this.steer * 0.5 * (1 + 0.55 * stunt) * Math.min(1, Math.abs(this.speed) / 9) *
        Math.sign(this.speed >= 0 ? 1 : -1),
      -0.68, 0.68);
    this.roll += (targetRoll - this.roll) * Math.min(1, 8 * dt);
    this.airPitch *= 1 - Math.min(1, 10 * dt);

    // Ground stunts (Phase 3I-5): ONLY the STUNT button pitches the bike.
    // GAS never wheelies, BRAKE never endos on their own. STUNT while
    // moving = controlled wheelie (throttle feeds the lift); STUNT+BRAKE
    // = endo. Hard braking alone gets a tiny cosmetic fork dive that can
    // never reach trick-detection thresholds. Purely an orientation/feel
    // layer — position, speed and collision never see it.
    if (!this.crashed && stunt > 0 && brake > 0.5 && this.speed > 4) {
      this.groundPitch = Math.max(-0.26, this.groundPitch - 2.0 * dt);
    } else if (!this.crashed && stunt > 0 && this.speed > 2.5) {
      this.groundPitch = Math.min(0.45, this.groundPitch + (1.1 + 0.7 * throttle) * dt);
    } else {
      this.groundPitch -=
        Math.sign(this.groundPitch) * Math.min(Math.abs(this.groundPitch), 2.6 * dt);
    }
    // SP-1 weight transfer: a separate, small orientation-only pitch —
    // throttle lightens the front (squat), braking loads the fork (dive),
    // proportional to actual force and speed. Lives on its OWN field so
    // stunt detection thresholds (groundPitch) never see it.
    const wt = (throttle > 0 && stunt === 0
        ? 0.05 * throttle * Math.min(1, Math.max(this.speed, 0) / 5)
        : 0) -
      0.09 * this._brakeEff * Math.min(1, Math.abs(this.speed) / 8);
    this.weightPitch += (wt - this.weightPitch) * Math.min(1, 6 * dt);
    // Ramp prep: holding STUNT preloads the suspension (~10 cm crouch);
    // the existing takeoff pop converts it into a slightly bigger launch.
    if (stunt > 0) this._suspVel -= 6 * dt;
  }

  _airStep(dt, throttle, brake, stunt = 0, trick = 0) {
    const prevX = this.position.x, prevZ = this.position.z, prevYair = this.position.y;
    this.velocity.y -= G * dt;
    if (this.velocity.y < -45) this.velocity.y = -45; // terminal fall speed
    this.weightPitch *= 1 - Math.min(1, 5 * dt);      // no squat/dive mid-air
    this.position.addScaledVector(this.velocity, dt);

    // TRICK button (Phase 3I-5): the ONLY way to flip. Committed rotation
    // with real momentum — hold to spin (backflip by default, frontflip
    // while BRAKE is also held); release stops ADDING rotation and the
    // spin bleeds off instead of snapping. Total rotation per flight is
    // capped (~2.5 turns). Without TRICK, gas/brake keep only the old
    // gentle attitude authority (clamped, can never complete a flip).
    let dPitch;
    if (trick > 0 || Math.abs(this._trickVel) > 0.08) {
      if (trick > 0) {
        const dir = brake > 0.4 ? -1 : 1;
        this._trickVel = THREE.MathUtils.clamp(this._trickVel + dir * 30 * dt, -8.0, 8.0);
      } else {
        this._trickVel -= Math.sign(this._trickVel) * Math.min(Math.abs(this._trickVel), 10 * dt);
      }
      if (Math.abs(this.airPitchTravel) > 15.5) {
        this._trickVel *= 1 - Math.min(1, 10 * dt); // no unlimited spinning
      }
      dPitch = this._trickVel * dt;
      this.airPitch += dPitch;
    } else {
      dPitch = (throttle * 1.0 - brake * 1.45) * dt;
      this.airPitch += dPitch;
      if (Math.abs(this.airPitch - dPitch) <= 0.82) {
        // Gentle mode clamps BELOW the crash-landing pitch (0.9): holding
        // gas/brake through a long flight can attitude the bike but never
        // by itself turn a clean landing into a crash (Phase 3 mountain
        // drops are much longer than Phase 2 lowland hops). Deliberate
        // TRICK rotations keep full risk. Never snap back mid-flip.
        this.airPitch = THREE.MathUtils.clamp(this.airPitch, -0.82, 0.82);
      }
    }
    this.airPitchTravel += dPitch;

    // STUNT in the air = orientation recovery: pulls the bike toward the
    // nearest level attitude at a bounded rate and damps trick spin —
    // the skill move before a sketchy landing. Never instant.
    if (stunt > 0) {
      const w = Math.atan2(Math.sin(this.airPitch), Math.cos(this.airPitch));
      const corr = Math.sign(w) * Math.min(Math.abs(w), 3.2 * dt);
      this.airPitch -= corr;
      this.airPitchTravel -= corr;
      this._trickVel *= 1 - Math.min(1, 6 * dt);
    }

    this.groundPitch *= 1 - Math.min(1, 5 * dt);
    // Steering spins the bike a little; TRICK boosts the air-turn rate.
    this.yaw -= this.steer * (0.8 + 1.2 * trick) * dt;
    this.roll += (this.steer * 0.35 - this.roll) * Math.min(1, (stunt > 0 ? 8 : 3) * dt);

    let groundY = this.world.getHeight(this.position.x, this.position.z);
    if (this.position.y <= groundY) {
      // Landing or lateral wall impact? If the ground here towers over both
      // our previous height and the previous column's ground, we flew INTO
      // a face — stop at it and keep falling instead of snapping on top.
      const groundPrev = this.world.getHeight(prevX, prevZ);
      const allow = Math.hypot(this.velocity.x, this.velocity.z) * dt * MAX_GROUND_SLOPE + 0.5;
      if (groundY - groundPrev > allow && groundY - prevYair > allow) {
        this.position.x = prevX;
        this.position.z = prevZ;
        this.velocity.x *= -0.15; // soft bounce off the face
        this.velocity.z *= -0.15;
        groundY = groundPrev;
        if (this.position.y > groundY) return; // still airborne, sliding down the face
      }
      this.position.y = groundY;
      this.grounded = true;
      this.slip = 0;
      this._trickVel = 0;
      // A completed flip is a level landing: judge (and continue) from the
      // wrapped angle, so full rotations land clean and half-flips crash.
      this.airPitch = Math.atan2(Math.sin(this.airPitch), Math.cos(this.airPitch));
      this.airPitchTravel = 0;

      // Keep only the speed component along the bike's heading.
      this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.speed = this.velocity.x * this.forward.x + this.velocity.z * this.forward.z;
      // Hard landings soak momentum into the suspension instead of the
      // rider keeping every m/s for free (rough landings feel weighty).
      // Phase 2 landing absorption: a touch less speed scrub, more of the
      // impact routed into visible suspension travel — landings feel
      // cushioned rather than braked.
      const impact = Math.max(0, -this.velocity.y - 5.5);
      this.speed *= 1 - Math.min(0.22, impact * 0.018);
      this.speed = THREE.MathUtils.clamp(this.speed, MAX_REVERSE, MAX_DOWNHILL);

      if (this.velocity.y < CRASH_LAND_VY && Math.abs(this.airPitch) > CRASH_LAND_PITCH) {
        this._crash();
      }
      this._suspVel += THREE.MathUtils.clamp(this.velocity.y * 0.3, -6, 0);
      this.velocity.set(0, 0, 0);
    }
  }

  _collideProps() {
    const colliders = this.world.getColliders();
    const px = this.position.x, pz = this.position.z;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const dx = px - c.x, dz = pz - c.z;
      const rr = c.r + 0.45;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-6) continue;

      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      // Push out of the collider.
      this.position.x = c.x + nx * rr;
      this.position.z = c.z + nz * rr;

      // Head-on component of travel into the prop.
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const into = -(fx * nx + fz * nz) * this.speed;
      if (into > CRASH_HIT_SPEED && !this.crashed) this._crash();
      this.speed *= 0.35;
      if (!this.grounded) { this.velocity.x *= 0.2; this.velocity.z *= 0.2; }
    }
  }

  _recordSafePosition(dt) {
    if (!this.grounded || this.crashed || Math.abs(this.roll) > 0.4 || this.speed < 0) return;
    this._safeTimer += dt;
    if (this._safeTimer < 1.5) return;
    this._safeTimer = 0;
    // Only accept reasonably flat ground — never reset onto a ramp face
    // or a steep hillside where the bike would roll away.
    this.world.getNormal(this.position.x, this.position.z, _v2);
    if (_v2.y < 0.96) return;
    // Don't record a spot that touches a prop collider.
    const colliders = this.world.getColliders();
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const dx = this.position.x - c.x, dz = this.position.z - c.z;
      if (dx * dx + dz * dz < (c.r + 2) * (c.r + 2)) return;
    }
    this._safe.x = this.position.x;
    this._safe.y = this.position.y;
    this._safe.z = this.position.z;
    this._safe.yaw = this.yaw;
  }

  _updateSuspension(dt) {
    // Critically-damped-ish spring for the visual chassis bob.
    // Phase 2: stiffer spring + a little more travel — the bike soaks
    // rolling-terrain bumps visibly and recovers faster after landings.
    const k = 72, damp = 10;
    this._suspVel += (-this.suspension * k - this._suspVel * damp) * dt;
    this.suspension = THREE.MathUtils.clamp(this.suspension + this._suspVel * dt, -0.22, 0.12);
  }

  _updateOrientation(dt) {
    const world = this.world;
    // Smoothly track the terrain normal (or world-up while airborne).
    if (this.grounded) {
      world.getNormal(this.position.x, this.position.z, _v2);
    } else {
      _v2.set(0, 1, 0);
    }
    const t = 1 - Math.exp(-(this.grounded ? 10 : 2.2) * dt);
    this.groundNormal.lerp(_v2, t).normalize();

    // Basis: up = smoothed normal, forward = heading projected on the plane.
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _v1.copy(this.forward)
      .addScaledVector(this.groundNormal, -this.forward.dot(this.groundNormal))
      .normalize();
    _v2.crossVectors(this.groundNormal, _v1); // right axis
    _m.makeBasis(_v2, this.groundNormal, _v1);
    this.quaternion.setFromRotationMatrix(_m);

    // Local lean (steer + crash tip) and pitch (airborne + ground stunts +
    // SP-1 weight transfer).
    const pitch = this.airPitch + this.groundPitch + this.weightPitch;
    _qLean.setFromAxisAngle(_axisZ, this.roll + this.crashRoll);
    _qPitch.setFromAxisAngle(_axisX, -pitch);
    this.quaternion.multiply(_qPitch).multiply(_qLean);

    // Wheelies/endos pitch about the CONTACT wheel, not the bike origin:
    // shift the visual model so the planted wheel stays planted (model
    // layer only — physics position is untouched).
    const gp = this.groundPitch;
    if (this.grounded && Math.abs(gp) > 0.002) {
      const pz = gp > 0 ? -0.66 : 0.62; // rear / front contact z (local)
      _v1.set(0, -pz * Math.sin(gp), pz * (1 - Math.cos(gp)));
      this.pivotShift.copy(_v1.applyQuaternion(this.quaternion));
    } else {
      this.pivotShift.set(0, 0, 0);
    }
  }
}
