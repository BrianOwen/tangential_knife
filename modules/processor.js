// processor.js — Tangential knife algorithm
// Machine axis stays on the programmed path. Blade rotates over the last
// bladeWidth of each segment approaching a corner.

const RAD2DEG = 180.0 / Math.PI;
const XY_DEC = 6;
const ANG_DEC = 3;

/**
 * Process parsed move groups to add B-axis tangential knife commands.
 *
 * @param {Array} moveGroups - From parser.parseSBP()
 * @param {object} options - { bladeWidth, pulloutAngle, safeZ }
 * @returns {object} { outputLines, stats }
 */
export function processFile(moveGroups, options) {
    const { bladeWidth, pulloutAngle, safeZ } = options;
    const outputLines = [];
    const stats = { cutPaths: 0, lifts: 0, totalMoves: 0, totalAngle: 0 };

    let totAngle = 0;

    for (const group of moveGroups) {
        const mQ = group.moves;
        const size = mQ.length;
        if (size < 2) continue;

        // Skip groups that are all jogs (no cutting)
        const hasFeed = mQ.some(m => m.moveType === 'F' || m.moveType === 'M');
        if (!hasFeed) {
            for (const m of mQ) {
                outputLines.push(`J3,${r(m.x)},${r(m.y)},${r(m.z)} 'Jog move`);
            }
            continue;
        }

        stats.cutPaths++;

        // Precompute directions for each segment
        // directions[i] = angle from point i to point i+1
        const directions = [];
        for (let i = 0; i < size - 1; i++) {
            const dx = mQ[i + 1].x - mQ[i].x;
            const dy = mQ[i + 1].y - mQ[i].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 1e-9) {
                directions[i] = Math.atan2(dy, dx) * RAD2DEG * -1;
            } else {
                // Zero-length segment — carry forward previous direction
                directions[i] = i > 0 ? directions[i - 1] : 0;
            }
        }
        directions[size - 1] = directions[size - 2]; // last point inherits

        // Precompute turns at each point
        // turns[i] = angle change at point i (from segment i-1→i to segment i→i+1)
        const turns = new Array(size).fill(0);
        for (let i = 1; i < size - 1; i++) {
            turns[i] = normalizeTurn(directions[i] - directions[i - 1]);
        }

        let status = 'J'; // J=jogging, P=plunging, M=cutting

        for (let i = 0; i < size; i++) {
            const cur = mQ[i];
            stats.totalMoves++;

            // --- Jog moves ---
            if (cur.moveType === 'J') {
                outputLines.push(`J3,${r(cur.x)},${r(cur.y)},${r(cur.z)} 'Jog move`);
                // Detect transition to plunge
                if (i + 1 < size && mQ[i + 1].moveType === 'F') {
                    status = 'P';
                }
                continue;
            }

            // --- Retract moves ---
            if (cur.moveType === 'R') {
                continue; // handled after loop
            }

            // --- First feed (plunge) ---
            if (status === 'P' || status === 'J') {
                // Set initial blade angle and plunge
                const dir = directions[i];
                const turn = normalizeTurn(dir - (totAngle % 360));
                totAngle += turn;
                outputLines.push(`JB,${ra(totAngle)} 'Rotate`);
                outputLines.push(`MZ,${r(cur.z)} 'Plunge`);
                status = 'M';
                continue;
            }

            // --- Cutting moves ---
            const prevDist = distance(mQ[i - 1].x, mQ[i - 1].y, cur.x, cur.y);
            const turn = turns[i]; // turn at THIS point (change from incoming to outgoing)

            if (Math.abs(turn) <= pulloutAngle) {
                // Small turn — rotate blade while moving straight

                if (Math.abs(turn) > 0.01 && prevDist >= bladeWidth) {
                    // Insert a point bladeWidth before cur along the incoming direction
                    // so the rotation spans exactly bladeWidth of distance
                    const inDir = directions[i - 1];
                    const inRad = -inDir / RAD2DEG; // convert back to math radians
                    const preX = cur.x - Math.cos(inRad) * bladeWidth;
                    const preY = cur.y - Math.sin(inRad) * bladeWidth;
                    // Z interpolated at that pre-point
                    const t = 1 - bladeWidth / prevDist;
                    const preZ = mQ[i - 1].z + (cur.z - mQ[i - 1].z) * t;
                    outputLines.push(
                        `M5,${r(preX)},${r(preY)},${r(preZ)},,${ra(totAngle)} 'Straight to turn start`
                    );
                }

                // Move to corner point with new angle
                totAngle += turn;
                outputLines.push(
                    `M5,${r(cur.x)},${r(cur.y)},${r(cur.z)},,${ra(totAngle)} 'Turn complete`
                );

            } else {
                // Large turn — lift, rotate, replunge

                // First, move to the corner at current angle
                outputLines.push(
                    `M5,${r(cur.x)},${r(cur.y)},${r(cur.z)},,${ra(totAngle)} 'Finish move before lift`
                );

                // Update angle for new direction
                totAngle += turn;
                stats.lifts++;

                // Lift
                outputLines.push(`JZ,${r(safeZ)} 'Lifting to turn blade`);
                outputLines.push(`JB,${ra(totAngle)} 'Rotate during lift`);

                // Unwind at 360
                if (Math.abs(totAngle) >= 360) {
                    totAngle = totAngle - 360 * Math.floor(totAngle / 360);
                    outputLines.push(`VA,,,,,${totAngle},,,,,0`);
                }

                // Plunge back
                outputLines.push(`MZ,${r(cur.z)} 'Plunge back in`);
            }
        }

        // Final move of the path — move to last point
        const last = mQ[size - 1];
        outputLines.push(`M2,${r(last.x)},${r(last.y)} 'Final move of path`);
        outputLines.push(`JZ,${r(safeZ)} 'Lifting at cut finish`);
        outputLines.push(`JB,${ra(totAngle)} 'Rotate during lift`);

        // Unwind if needed
        if (Math.abs(totAngle) >= 360) {
            totAngle = totAngle - 360 * Math.floor(totAngle / 360);
            outputLines.push(`VA,,,,,${totAngle},,,,,0`);
        }

        stats.totalAngle = totAngle;
    }

    return { outputLines, stats };
}

// --- Helpers ---

function distance(x1, y1, x2, y2) {
    return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

/** Normalize a turn angle to [-180, 180] */
function normalizeTurn(turn) {
    while (turn > 180) turn -= 360;
    while (turn < -180) turn += 360;
    return turn;
}

function r(num) { return num.toFixed(XY_DEC); }
function ra(num) { return num.toFixed(ANG_DEC); }
