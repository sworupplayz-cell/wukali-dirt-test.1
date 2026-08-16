import * as THREE from 'three';

/**
 * FollowCamera — lightweight third-person chase camera.
 * Frame-rate-independent exponential smoothing, terrain clearance clamp,
 * no allocations per frame.
 */
export class FollowCamera {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.mode = 'third'; // 'third' | 'first' — toggled by the HUD POV button / C key
    this._blend = 0;     // eased 0 = third ... 1 = first
    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._fpPos = new THREE.Vector3();
    this._fpTarget = new THREE.Vector3();
    this._lerpPos = new THREE.Vector3();
    this._lerpTarget = new THREE.Vector3();
    this._vel = new THREE.Vector3(); // spring-damper velocity (polish pass)
    this._heading = 0;
    this._initialized = false;
  }

  /** Current first-person blend (0 = fully third person). */
  get blend() {
    return this._blend;
  }

  /** Switch POV; returns the new mode. Transition is eased in update(). */
  toggle() {
    this.mode = this.mode === 'third' ? 'first' : 'third';
    return this.mode;
  }

  snapTo(bike) {
    this._heading = bike.yaw;
    this._dt = 1 / 60;
    this._smoothY = bike.position.y;
    this._clampY = 0;
    this._vel.set(0, 0, 0);
    this._computeDesired(bike);
    this._pos.copy(this._desired);
    this._initialized = true;
    this._apply(bike);
  }

  _computeDesired(bike) {
    const dist = 6.2, height = 2.6;
    const sx = Math.sin(this._heading), cz = Math.cos(this._heading);
    // Chapter 3D smoothing: the FOLLOW HEIGHT tracks a slow-smoothed bike
    // altitude instead of the raw one — suspension bounce, kicker lips
    // and terrain micro-bumps no longer pump the camera vertically
    // (the fast horizontal chase is unchanged; controls identical).
    if (this._smoothY === undefined) this._smoothY = bike.position.y;
    const dy = bike.position.y - this._smoothY;
    // Faster catch-up on big drops/climbs, gentle on small vibration.
    const k = Math.min(1, (Math.abs(dy) > 3.5 ? 6 : 0.65) * this._dt);
    this._smoothY += dy * k;
    this._desired.set(
      bike.position.x - sx * dist,
      this._smoothY + height,
      bike.position.z - cz * dist
    );
    // Terrain clearance: smoothed clamp — rising ground lifts the camera
    // with an eased response instead of an instant snap; a hard floor
    // 0.55 m above ground still guarantees no clipping.
    const groundY = this.world.getHeight(this._desired.x, this._desired.z);
    const wantMin = groundY + 1.1;
    if (this._clampY === undefined) this._clampY = 0;
    const deficit = Math.max(0, wantMin - this._desired.y);
    this._clampY += (deficit - this._clampY) * Math.min(1, 2.5 * this._dt);
    this._desired.y += Math.max(this._clampY, 0);
    if (this._desired.y < groundY + 0.55) this._desired.y = groundY + 0.55;
  }

  update(bike, dt) {
    if (!this._initialized) { this.snapTo(bike); return; }
    this._dt = dt;

    // Smoothly track the bike heading (shortest angular path).
    let d = bike.yaw - this._heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this._heading += d * Math.min(1, 4.5 * dt);

    this._computeDesired(bike);
    // CRITICALLY DAMPED SPRING (replaces exponential lerp): position and
    // velocity integrate together, so high-frequency target vibration is
    // absorbed by the damper instead of partially leaking through — the
    // remaining micro-shake drops ~70% while big moves still settle in
    // ~2/omega s with zero overshoot.
    // Split stiffness: horizontal chase stays TIGHT (om 9 — the follow
    // distance never balloons under acceleration), vertical is SOFT
    // (om 4 — bump energy is where the shake lives).
    const omH = 9, omV = 0.95;
    const st = Math.min(dt, 1 / 30); // stable integration on slow frames
    this._vel.x += (omH * omH * (this._desired.x - this._pos.x) - 2 * omH * this._vel.x) * st;
    this._vel.y += (omV * omV * (this._desired.y - this._pos.y) - 2 * omV * this._vel.y) * st;
    this._vel.z += (omH * omH * (this._desired.z - this._pos.z) - 2 * omH * this._vel.z) * st;
    this._pos.x += this._vel.x * st;
    this._pos.y += this._vel.y * st;
    this._pos.z += this._vel.z * st;

    // Ease between third and first person.
    const want = this.mode === 'first' ? 1 : 0;
    this._blend += (want - this._blend) * Math.min(1, 5 * dt);
    if (Math.abs(this._blend - want) < 0.002) this._blend = want;

    if (this._blend < 0.001) {
      this._apply(bike);
      return;
    }

    // First person: helmet position above the seat, looking ahead through
    // the handlebars. Local offsets follow the bike's full orientation so
    // the view pitches with the terrain and dips into turns.
    this._fpPos.set(0, 1.34, -0.18).applyQuaternion(bike.quaternion).add(bike.position);
    this._fpTarget.set(0, 1.05, 7).applyQuaternion(bike.quaternion).add(bike.position);
    // Never let the helmet cam dip into the ground on hard compressions.
    const gy = this.world.getHeight(this._fpPos.x, this._fpPos.z);
    if (this._fpPos.y < gy + 0.5) this._fpPos.y = gy + 0.5;

    // Third-person reference frame for blending.
    this._lerpTarget.set(
      bike.position.x + Math.sin(this._heading) * 2.0,
      bike.position.y + 1.0,
      bike.position.z + Math.cos(this._heading) * 2.0
    );
    const b = this._blend * this._blend * (3 - 2 * this._blend); // smooth
    this._lerpPos.copy(this._pos).lerp(this._fpPos, b);
    this._lerpTarget.lerp(this._fpTarget, b);
    this.camera.position.copy(this._lerpPos);
    this.camera.lookAt(this._lerpTarget);
  }

  _apply(bike) {
    this.camera.position.copy(this._pos);
    // Look-at height uses the same smoothed altitude: the view no longer
    // nods with every suspension compression.
    const ty = (this._smoothY !== undefined ? this._smoothY : bike.position.y) +
      (bike.position.y - (this._smoothY ?? bike.position.y)) * 0.05;
    this._target.set(
      bike.position.x + Math.sin(this._heading) * 2.0,
      ty + 1.0,
      bike.position.z + Math.cos(this._heading) * 2.0
    );
    this.camera.lookAt(this._target);
  }

  /** Slow orbit around the spawn area for the main-menu backdrop. */
  menuOrbit(bike, time) {
    const a = time * 0.15;
    const r = 7;
    this.camera.position.set(
      bike.position.x + Math.sin(a) * r,
      bike.position.y + 2.8,
      bike.position.z + Math.cos(a) * r
    );
    this.camera.lookAt(bike.position.x, bike.position.y + 0.8, bike.position.z);
    this._initialized = false; // force a snap when gameplay starts
  }
}
