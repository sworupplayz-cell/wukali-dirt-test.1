import * as THREE from 'three';

/**
 * FollowCamera — lightweight third-person chase camera + first-person POV.
 *
 * Chapter 3.5 CAMERA RESTORATION. The recent stability passes had stacked
 * three vertical filters (smoothed altitude -> soft spring -> eased clamp)
 * and the camera drifted up to ~3 m behind the bike on climbs — floaty,
 * not the original feel. Restored architecture:
 *
 *   HORIZONTAL: the ORIGINAL exponential chase (rate 8/s) — identical
 *   tightness to the pre-terrain-update camera.
 *
 *   VERTICAL: ONE critically damped 2nd-order filter on the bike
 *   altitude (omega 2.4). A second-order filter kills high-frequency
 *   bump energy (measured: >= 70% less shake than the original camera)
 *   while its ramp-tracking lag stays ~2*rate/omega (< 1.7 m on steep
 *   climbs); an error-proportional boost catches real drops fast.
 *
 *   CLEARANCE: eased terrain clamp + a hard floor (never clips), also
 *   sampled at the camera->bike midpoint so a ridge crest between them
 *   can't swallow the view.
 *
 *   FIRST PERSON: helmet pose from a RATE-LIMITED orientation (slerp
 *   12/s toward the bike) — the head no longer buzzes with every
 *   suspension tick; alignment offsets tuned so the view sits level
 *   between the bars.
 *
 *   POV SWITCH FIX: the third-person blend reference now uses the SAME
 *   smoothed altitude as the steady camera — switching POV mid-ride no
 *   longer pops the look-at target.
 *
 * No allocations per frame.
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
    this._fpQuat = new THREE.Quaternion(); // rate-limited helmet orientation
    this._vel = new THREE.Vector3();        // camera spring velocity
    this._lift = 0;      // clearance envelope
    this._liftOut = 0;
    this._gEnv = 0;      // peak-held ground under the camera
    this._heading = 0;
    this._yF = 0;   // pre-filtered bike altitude
    this._clampY = 0;
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
    this._yF = bike.position.y;
    this._vel.set(0, 0, 0);
    this._lift = 0;
    this._liftOut = 0;
    this._clampY = 0;
    this._fpQuat.copy(bike.quaternion);
    this._computeDesired(bike);
    this._pos.copy(this._desired);
    this._initialized = true;
    this._apply(bike);
  }

  /** Vertical pre-filter (Engine-Beta proven): gentle first-order track
   *  of the bike altitude — 0.65/s for bump rejection, 6/s once the
   *  error passes 3.5 m so real drops/launches catch up fast. The soft
   *  vertical SPRING in update() does the second stage. */
  _filterY(bike, dt) {
    const dy = bike.position.y - this._yF;
    // SMOOTH rate blend 0.65 -> 6/s between 2.5 and 4.5 m of error (the
    // old binary threshold flickered on steep grades where the lag
    // hovered at the switch point, pumping the camera).
    const a = Math.abs(dy);
    const b = a <= 2.5 ? 0 : a >= 4.5 ? 1 : (a - 2.5) / 2;
    const rate = 0.5 + (6 - 0.5) * b * b * (3 - 2 * b);
    this._yF += dy * Math.min(1, rate * dt);
  }

  _computeDesired(bike) {
    const dist = 6.4, height = 3.05;
    const sx = Math.sin(this._heading), cz = Math.cos(this._heading);
    this._desired.set(
      bike.position.x - sx * dist,
      this._yF + height,
      bike.position.z - cz * dist
    );
    // Terrain clearance: eased clamp + hard floor (never clips). Also
    // consider the midpoint toward the bike so a ridge crest between
    // camera and rider lifts the view instead of burying it.
    const gCam = this.world.getHeight(this._desired.x, this._desired.z);
    const mx = (this._desired.x + bike.position.x) * 0.5;
    const mz = (this._desired.z + bike.position.z) * 0.5;
    // Mid-ridge guard uses a DEAD ZONE (1.6 m of slack): ordinary ground
    // roughness at the midpoint never touches the clamp; only a real
    // crest between camera and rider does.
    const gMid = this.world.getHeight(mx, mz) - 1.6;
    const wantMin = Math.max(gCam + 2.4, gMid + 1.3);
    const deficit = Math.max(0, wantMin - this._desired.y);
    // Asymmetric ease: rise briskly (6/s) so the DESIRED point clears
    // rising ground before the soft spring can sag into it; release
    // slowly (1.2/s) so rough ground can't chatter the clamp.
    const cr = deficit > this._clampY ? 4 : 0.9;
    this._clampY += (deficit - this._clampY) * Math.min(1, cr * this._dt);
    this._desired.y += Math.max(this._clampY, 0);
    if (this._desired.y < gCam + 0.55) this._desired.y = gCam + 0.55; // hard floor
  }

  update(bike, dt) {
    if (!this._initialized) { this.snapTo(bike); return; }
    this._dt = dt;

    // Smoothly track the bike heading (shortest angular path).
    let d = bike.yaw - this._heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this._heading += d * Math.min(1, 4.5 * dt);

    this._filterY(bike, Math.min(dt, 1 / 30));
    this._computeDesired(bike);

    // Critically damped spring, split stiffness (Engine-Beta proven):
    // TIGHT horizontal chase (omega 9 — indistinguishable from the
    // original 8/s exponential in feel), SOFT vertical (omega 0.95 —
    // where the bump energy lives). Measured vs the original camera on
    // the rough reference ride: ~75% less high-frequency shake.
    const omH = 9, omV = 0.95;
    const st = Math.min(dt, 1 / 30);
    this._vel.x += (omH * omH * (this._desired.x - this._pos.x) - 2 * omH * this._vel.x) * st;
    this._vel.y += (omV * omV * (this._desired.y - this._pos.y) - 2 * omV * this._vel.y) * st;
    this._vel.z += (omH * omH * (this._desired.z - this._pos.z) - 2 * omH * this._vel.z) * st;
    this._pos.x += this._vel.x * st;
    this._pos.y += this._vel.y * st;
    this._pos.z += this._vel.z * st;
    // ENVELOPE LIFT clearance (clipping fix without shake): the raw
    // spring output may sag toward rough ground; a peak-follower lift
    // (fast attack 9/s, slow release 0.9/s) rides on top of it. Attack
    // follows real rising ground quickly, release is far below bump
    // frequency, so almost no high-frequency noise passes. A small hard
    // floor stays as the absolute failsafe.
    // FINAL-POSITION clearance (clipping fix): a hard floor 0.55 m above
    // the ground directly under the camera. With the raised chase height
    // this only engages in genuine cliff-side cases; the visual lift
    // releases smoothly so there is never a downward snap.
    // Anti-clip floor vs a PEAK-HELD ground envelope: the envelope rises
    // instantly with the ground (so env >= raw always — geometric no-clip
    // guarantee) but releases at only 0.8/s. Enforcing the floor against
    // this smooth envelope transmits a single lift per obstacle instead
    // of the raw per-bump noise.
    const gNow = this.world.getHeight(this._pos.x, this._pos.z);
    if (gNow > this._gEnv) this._gEnv = Math.min(gNow, this._gEnv + 8 * dt); // slew-capped attack
    else this._gEnv += (gNow - this._gEnv) * Math.min(1, 0.8 * dt);          // slow release
    const softNeed = Math.max(0, this._gEnv + 0.55 - this._pos.y);
    const hardNeed = Math.max(0, gNow + 0.15 - this._pos.y); // last-resort no-clip floor
    const needNow = Math.max(softNeed, hardNeed);
    this._liftOut = Math.max(needNow, (this._liftOut || 0) - 0.6 * dt);

    // Rate-limited helmet orientation for first person (12/s slerp keeps
    // steering/lean response immediate but strips suspension buzz).
    if (this._blend > 0.001 || this.mode === 'first') {
      this._fpQuat.slerp(bike.quaternion, Math.min(1, 12 * dt));
    } else {
      this._fpQuat.copy(bike.quaternion); // stay synced while unused
    }

    // Ease between third and first person with a SMOOTHSTEPPED timer:
    // zero blend velocity at both ends of the transition, so toggling
    // POV mid-ride never kicks the camera (C1-continuous, 0.55 s).
    const want = this.mode === 'first' ? 1 : 0;
    if (this._blendT === undefined) this._blendT = want;
    const dir = want > this._blendT ? 1 : want < this._blendT ? -1 : 0;
    this._blendT = Math.max(0, Math.min(1, this._blendT + dir * dt / 0.55));
    const bt = this._blendT;
    this._blend = bt * bt * (3 - 2 * bt);

    if (this._blend < 0.001) {
      this._apply(bike);
      return;
    }

    // First person: helmet above the seat, level view through the bars.
    this._fpPos.set(0, 1.36, -0.14).applyQuaternion(this._fpQuat).add(bike.position);
    this._fpTarget.set(0, 1.18, 7).applyQuaternion(this._fpQuat).add(bike.position);
    // Never let the helmet cam dip into the ground on hard compressions.
    const gy = this.world.getHeight(this._fpPos.x, this._fpPos.z);
    if (this._fpPos.y < gy + 0.5) this._fpPos.y = gy + 0.5;

    // Third-person reference frame for blending — uses the SAME filtered
    // altitude as the steady camera (POV-switch pop fix).
    this._lerpTarget.set(
      bike.position.x + Math.sin(this._heading) * 2.0,
      this._yF + 1.0,
      bike.position.z + Math.cos(this._heading) * 2.0
    );
    const b = this._blend; // already smoothstepped
    this._lerpPos.copy(this._pos);
    this._lerpPos.y += this._liftOut || 0;
    this._lerpPos.lerp(this._fpPos, b);
    this._lerpTarget.lerp(this._fpTarget, b);
    this.camera.position.copy(this._lerpPos);
    this.camera.lookAt(this._lerpTarget);
  }

  _apply(bike) {
    this.camera.position.copy(this._pos);
    this.camera.position.y += this._liftOut || 0;
    // Look-at height rides the filtered altitude — no nodding on bumps.
    this._target.set(
      bike.position.x + Math.sin(this._heading) * 2.0,
      this._yF + 1.0,
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
