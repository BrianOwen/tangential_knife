// vector-to-movegroups.js — Convert parsed vector paths into moveGroups
// that processor.js can consume for tangential knife processing.
// Supports per-path cut depth and multiple depth passes.

/**
 * Convert selected vector paths into the moveGroup format expected by processFile().
 *
 * Each path has its own cutDepth and passes. Each depth pass produces one moveGroup:
 *   J (jog to safe Z at start XY)
 *   F (first feed/plunge — triggers blade rotation in processor)
 *   M (cutting moves along the path)
 *   R (retract to safe Z — signals end of cut path)
 *
 * @param {Array} paths - Array of { points, isClosed, cutDepth, passes }
 * @param {object} opts - { safeZ }
 * @returns {Array} moveGroups compatible with processor.js
 */
export function convertPathsToMoveGroups(paths, { safeZ }) {
  const moveGroups = [];

  for (const path of paths) {
    const pts = path.points;
    if (pts.length < 2) continue;

    const totalDepth = Math.abs(path.cutDepth || 0.125);
    const passes = Math.max(1, path.passes || 1);
    const depthPerPass = totalDepth / passes;

    for (let p = 1; p <= passes; p++) {
      const zCut = -(depthPerPass * p);
      const moves = [];

      // Jog to start position at safe Z
      moves.push({ x: pts[0].x, y: pts[0].y, z: safeZ, moveType: 'J' });

      // First feed move — plunge to this pass depth
      moves.push({ x: pts[0].x, y: pts[0].y, z: zCut, moveType: 'F' });

      // Cutting moves along the path
      for (let i = 1; i < pts.length; i++) {
        moves.push({ x: pts[i].x, y: pts[i].y, z: zCut, moveType: 'M' });
      }

      // Close the path if needed
      if (path.isClosed) {
        moves.push({ x: pts[0].x, y: pts[0].y, z: zCut, moveType: 'M' });
      }

      // Retract
      const lastPt = path.isClosed ? pts[0] : pts[pts.length - 1];
      moves.push({ x: lastPt.x, y: lastPt.y, z: safeZ, moveType: 'R' });

      moveGroups.push({ moves });
    }
  }

  return moveGroups;
}
