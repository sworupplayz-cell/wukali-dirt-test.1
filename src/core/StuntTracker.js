/**
 * StuntTracker (Phase 3I-1) — readable tricks chained into combos, detected
 * purely by observing the bike's physics state. No allocations per step.
 *
 * TRICKS (each must actually be performed — thresholds + hysteresis stop
 * tiny bounces from scoring):
 *   WHEELIE      +50   groundPitch > 0.32 sustained 0.7 s (re-arms < 0.12)
 *   ENDO         +50   groundPitch < -0.16 sustained 0.5 s (re-arms > -0.06)
 *   AIR          +25   airborne >= 0.45 s or peak >= 1.1 m   (on landing)
 *   BIG AIR      +60   airborne >= 1.2 s or peak >= 3 m
 *   HUGE AIR     +100  airborne >= 1.9 s or peak >= 5 m
 *   SPIN         +100  >= 1.0 rad of yaw spin in one flight (once/flight)
 *   BACKFLIP     +150  full nose-up rotation in the air (each full turn)
 *   FRONTFLIP    +150  full nose-down rotation in the air
 *   CLEAN LANDING +50  landing a flight that scored an air trick
 *
 * COMBO: the Nth trick of a chain pays base x min(N, 5); points accumulate
 * UNBANKED. A clean landing banks them ("CLEAN LANDING"); riding normally
 * for ~1.6 s banks whatever is pending and ends the chain; crashing or a
 * bad landing loses everything unbanked ("COMBO LOST").
 */
const CHAIN_WINDOW = 1.6; // s of normal riding before the chain ends
const MAX_MULT = 5;

const FLIP_ANGLE = 2 * Math.PI - 0.7; // forgiving full rotation
const TWO_PI = 2 * Math.PI;

export class StuntTracker {
  constructor() {
    this.score = 0;   // banked points (HUD / game over / tests)
    this.combo = 1;   // multiplier the NEXT trick would get (1..5)
    this.onStunt = null; // (label, pts, comboCount) — bank / loss toast
    this.onCombo = null; // (count, pending, mult) — live combo HUD

    this._count = 0;     // tricks in the current chain
    this._pending = 0;   // unbanked points
    this._chainT = 0;    // grounded time left before the chain ends
    this._lastLabel = '';
    this._wheelies = 0;  // chain composition (composable combo naming)
    this._flips = 0;
    this._spins = 0;
    this._airs = 0;
    this._airLabel = '';
    this._pendingHasLanding = false;
    this.comboLines = []; // "BACKFLIP +300" strings for the combo panel

    this._air = false;
    this._t = 0;
    this._peak = 0;
    this._sx = 0;
    this._sz = 0;
    this._rot = 0;
    this._prevYaw = 0;
    this._rotDone = false;
    this._flightFlips = 0;
    this._flightSpin = false;

    this._wheelieT = 0;
    this._wheelieArmed = true;
    this._endoT = 0;
    this._endoArmed = true;
  }

  /** New run. */
  reset() {
    this.score = 0;
    this._clearChain();
    this._air = false;
    this._wheelieT = 0; this._wheelieArmed = true;
    this._endoT = 0; this._endoArmed = true;
  }

  /** Abort any in-flight tracking (manual bike reset / teleport). */
  cancel() {
    this._clearChain();
    this._air = false;
  }

  _clearChain() {
    this._count = 0;
    this._pending = 0;
    this._chainT = 0;
    this.combo = 1;
    this._wheelies = this._flips = this._spins = this._airs = 0;
    this._airLabel = '';
    this._pendingHasLanding = false;
    this.comboLines.length = 0;
    if (this.onCombo) this.onCombo(0, 0, 1);
  }

  /** Trick performed: pay it into the chain at the current multiplier. */
  _award(label, base) {
    const mult = Math.min(this._count + 1, MAX_MULT);
    this._count++;
    const pts = base * mult;
    this._pending += pts;
    this._lastLabel = label;
    this._chainT = CHAIN_WINDOW;
    this.combo = Math.min(this._count + 1, MAX_MULT);
    if (label === 'WHEELIE') this._wheelies++;
    else if (label === 'BACKFLIP' || label === 'FRONTFLIP') this._flips++;
    else if (label === 'SPIN') this._spins++;
    else if (label.endsWith('AIR')) { this._airs++; this._airLabel = label; }
    this.comboLines.push(`${label} +${pts}`);
    if (this.comboLines.length > 4) this.comboLines.shift();
    if (this.onCombo) this.onCombo(this._count, this._pending, Math.min(this._count, MAX_MULT));
  }

  /** Composable combo name from what the chain actually contained. */
  _comboName() {
    if (this._count >= 5) return 'EXTREME COMBO';
    if (this._wheelies > 0 && this._flips > 0) return 'WHEELIE FLIP';
    if (this._flips >= 2) return 'FLIP COMBO';
    if (this._flips >= 1 && this._spins >= 1) return 'AERIAL COMBO';
    // A plain jump (one air trick + its clean landing) reads as the air tier.
    const nonLanding = this._count - (this._pendingHasLanding ? 1 : 0);
    if (nonLanding === 1 && this._airs === 1 && this._wheelies + this._flips + this._spins === 0) {
      return this._airLabel || this._lastLabel;
    }
    return `COMBO x${Math.min(this._count, MAX_MULT)}`;
  }

  /** Bank the pending points (clean landing or quiet chain timeout). */
  _bank(atLanding) {
    if (this._pending > 0) {
      this.score += this._pending;
      const label = this._count > 1 ? this._comboName() : this._lastLabel;
      if (this.onStunt) this.onStunt(label, this._pending, this._count);
    }
    this._pending = 0;
    this._wheelies = this._flips = this._spins = this._airs = 0;
    this._airLabel = '';
    this._pendingHasLanding = false;
    this.comboLines.length = 0;
    if (this.onCombo) this.onCombo(this._count, 0, Math.min(Math.max(this._count, 1), MAX_MULT));
    // The multiplier ladder survives for one more CHAIN_WINDOW so quick
    // back-to-back jumps keep climbing; _chainT expiry ends the chain.
  }

  /** Crash / bad landing: the unbanked combo is lost. */
  _lose() {
    const lostPoints = this._pending > 0; // banked points are safe — only toast a real loss
    this._count = 0;
    this._pending = 0;
    this._chainT = 0;
    this.combo = 1;
    this._wheelies = this._flips = this._spins = this._airs = 0;
    this._airLabel = '';
    this._pendingHasLanding = false;
    this.comboLines.length = 0;
    if (lostPoints && this.onStunt) this.onStunt('COMBO LOST', 0, 0);
    if (this.onCombo) this.onCombo(0, 0, 1);
  }

  /** Per fixed step, after bike.update(). */
  step(bike, dt) {
    if (bike.crashed) {
      if (this._air) this._air = false;
      this._lose();
      this._wheelieT = 0;
      this._endoT = 0;
      return;
    }

    if (!this._air) {
      if (!bike.grounded) {
        // Takeoff.
        this._air = true;
        this._t = 0;
        this._peak = 0;
        this._sx = bike.position.x;
        this._sz = bike.position.z;
        this._rot = 0;
        this._prevYaw = bike.yaw;
        this._rotDone = false;
        this._flips = 0;
        return;
      }
      this._groundStep(bike, dt);
      return;
    }

    // ---- Airborne ----------------------------------------------------------
    this._t += dt;
    if (bike.heightAboveGround > this._peak) this._peak = bike.heightAboveGround;
    let dy = bike.yaw - this._prevYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this._rot += dy;
    this._prevYaw = bike.yaw;

    // Mid-air awards (responsive: the combo HUD ticks while flying).
    if (!this._rotDone && Math.abs(this._rot) >= 1.0) {
      this._rotDone = true;
      this._flightSpin = true;
      this._award('SPIN', 100);
    }
    const travel = bike.airPitchTravel;
    const flipsNow = Math.floor((Math.abs(travel) + (TWO_PI - FLIP_ANGLE)) / TWO_PI);
    while (this._flightFlips < flipsNow) {
      this._flightFlips++;
      this._award(travel > 0 ? 'BACKFLIP' : 'FRONTFLIP', 150);
    }

    if (bike.grounded) this._land(bike);
  }

  _land(bike) {
    this._air = false;
    const dist = Math.hypot(bike.position.x - this._sx, bike.position.z - this._sz);
    if (dist > 60) { this.cancel(); return; } // teleport mid-"flight": not a stunt

    // Air-time trick (evaluated at landing so the tier is known).
    let scoredAir = this._flightFlips > 0 || this._flightSpin;
    if (this._t >= 1.9 || this._peak >= 5) { this._award('HUGE AIR', 100); scoredAir = true; }
    else if (this._t >= 1.2 || this._peak >= 3) { this._award('BIG AIR', 60); scoredAir = true; }
    else if (this._t >= 0.45 || this._peak >= 1.1) { this._award('AIR', 25); scoredAir = true; }

    // bike.crashed landings never reach here (handled at the top of step);
    // this is a clean landing. A flight that scored pays a landing bonus,
    // then everything banks.
    if (scoredAir) {
      this._pendingHasLanding = true;
      this._award('CLEAN LANDING', 50);
    }
    this._bank(true);
  }

  _groundStep(bike, dt) {
    // Wheelie: sustained nose-up beyond a real angle, once per lift.
    if (bike.groundPitch > 0.32) {
      this._wheelieT += dt;
      if (this._wheelieArmed && this._wheelieT >= 0.7) {
        this._wheelieArmed = false;
        this._award('WHEELIE', 50);
      }
    } else if (bike.groundPitch < 0.12) {
      this._wheelieT = 0;
      this._wheelieArmed = true;
    }
    // Endo: sustained nose-down under braking (stoppies are short by nature).
    if (bike.groundPitch < -0.12) {
      this._endoT += dt;
      if (this._endoArmed && this._endoT >= 0.3) {
        this._endoArmed = false;
        this._award('ENDO', 50);
      }
    } else if (bike.groundPitch > -0.06) {
      this._endoT = 0;
      this._endoArmed = true;
    }

    // Chain countdown while riding normally (frozen during an active
    // wheelie/endo so a long wheelie can flow into a jump).
    if (this._chainT > 0 && Math.abs(bike.groundPitch) < 0.12) {
      this._chainT -= dt;
      if (this._chainT <= 0) {
        this._bank(false); // ground-only combos still pay out
        this._count = 0;
        this.combo = 1;
        if (this.onCombo) this.onCombo(0, 0, 1);
      }
    }
  }
}
