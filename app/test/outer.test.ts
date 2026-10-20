// Land around the map (sim/outer.ts): joins the map edge, is deterministic, and the physics grids match it.
import { describe, expect, it } from 'vitest';
import { OUTER_NEAR, outerGrid, outerHeight, outerSpec } from '../src/sim/outer';
import { groundHeight } from '../src/sim/layout';
import { layout } from './helpers';

const MAPS = ['training_field', 'abandoned_factory', 'ruined_district', 'parking_garage'];

describe('outer land', () => {
  for (const id of MAPS) {
    it(`${id}: continues the map edge without a step`, () => {
      const L = layout(id), s = outerSpec(L);
      for (let t = -1; t <= 1; t += 0.125) {
        const x = s.half, z = t * s.half;
        expect(Math.abs(outerHeight(s, x, z) - groundHeight(L, x, z))).toBeLessThan(1e-6);
        // 1 m outside: still within a few cm of the edge (no cliff)
        expect(Math.abs(outerHeight(s, x + 1, z) - groundHeight(L, x, z))).toBeLessThan(0.1);
      }
    });
  }

  it('is deterministic and rises into a far range', () => {
    const s = outerSpec(layout('training_field'));
    expect(outerHeight(s, 1234.5, -987.25)).toBe(outerHeight(s, 1234.5, -987.25));
    let maxNear = 0, maxFar = 0;
    for (let a = 0; a < 64; a++) {
      const th = (a / 64) * Math.PI * 2;
      maxNear = Math.max(maxNear, outerHeight(s, Math.cos(th) * 500, Math.sin(th) * 500));
      maxFar = Math.max(maxFar, outerHeight(s, Math.cos(th) * 3500, Math.sin(th) * 3500));
    }
    expect(maxFar).toBeGreaterThan(maxNear + 100);
  });

  it('physics grid samples the same surface and leaves a hole under the map', () => {
    const s = outerSpec(layout('training_field'));
    const size = 2 * OUTER_NEAR.half, res = size / OUTER_NEAR.cell, n = res + 1;
    const hf = outerGrid(s, size, res, s.half, -50);
    const at = (x: number, z: number) => hf[Math.round((z + size / 2) / OUTER_NEAR.cell) + Math.round((x + size / 2) / OUTER_NEAR.cell) * n];
    expect(at(0, 0)).toBe(-50);
    expect(at(600, -300)).toBeCloseTo(outerHeight(s, 600, -300), 5);
    expect(at(s.half, 0)).toBeCloseTo(outerHeight(s, s.half, 0), 5); // the border row is real ground
  });
});
