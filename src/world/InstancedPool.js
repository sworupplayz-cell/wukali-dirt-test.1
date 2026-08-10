import * as THREE from 'three';
import { PROP_TYPES } from './props.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

/**
 * InstancedPool — one InstancedMesh per prop type with a fixed capacity.
 * Props are never created/destroyed as objects while riding: chunk load /
 * unload only rewrites instance matrices (object pooling at the GPU level).
 */
export class InstancedPool {
  constructor(scene) {
    const front = new THREE.MeshLambertMaterial({ vertexColors: true });
    const both = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.meshes = PROP_TYPES.map((t) => {
      const mesh = new THREE.InstancedMesh(t.build(), t.doubleSided ? both : front, t.max);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      // Instances span the whole active area; per-mesh culling is useless.
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    });
  }

  /** Rewrite all instance matrices from the active chunks' prop lists. */
  rebuild(chunks) {
    const counts = this._counts || (this._counts = new Array(this.meshes.length));
    counts.fill(0);
    for (const chunk of chunks) {
      const props = chunk.props;
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        const n = counts[p.t];
        if (n >= PROP_TYPES[p.t].max) continue; // pool full: skip gracefully
        _p.set(p.x, p.y, p.z);
        _e.set(p.rx || 0, p.yaw, 0);
        _q.setFromEuler(_e);
        _s.setScalar(p.s);
        this.meshes[p.t].setMatrixAt(n, _m.compose(_p, _q, _s));
        counts[p.t] = n + 1;
      }
    }
    for (let t = 0; t < this.meshes.length; t++) {
      this.meshes[t].count = counts[t];
      this.meshes[t].instanceMatrix.needsUpdate = true;
    }
  }

  totalInstances() {
    let n = 0;
    for (const m of this.meshes) n += m.count;
    return n;
  }
}
