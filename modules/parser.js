// parser.js — Parse ShopBot .sbp files into structured move sequences

// Arc linearization resolution (degrees per segment)
const ARC_STEP_DEG = 2;

/**
 * Parse an SBP file into a list of commands.
 * CG arc commands are linearized into small line segments.
 *
 * Returns { moveGroups, headerLines, footerLines, safeZ, rawLines }
 * - moveGroups: cut paths, each = { moves: [{x, y, z, moveType}...] }
 * - headerLines: raw text lines before first move
 * - footerLines: raw text lines after last move
 */
export function parseSBP(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    // First pass: expand CG arcs, track positions, build a flat move list
    const entries = [];   // { type, x, y, z, raw, isMove, isJog, isCG }
    let curX = 0, curY = 0, curZ = 0;
    let detectedSafeZ = 0.5;
    let firstMoveIdx = -1;
    let lastMoveIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();

        if (trimmed === '' || trimmed.startsWith("'")) {
            entries.push({ type: 'comment', raw, isMove: false });
            continue;
        }

        // Strip inline comments for parsing
        const commentPos = trimmed.indexOf("'");
        const codePart = commentPos >= 0 ? trimmed.substring(0, commentPos).trim() : trimmed;
        const parts = codePart.split(',');
        const cmd = parts[0].trim().toUpperCase();
        const args = parts.slice(1).map(a => a.trim());

        if (cmd === 'CG') {
            // Linearize arc: CG, [clearance], endX, endY, centerI, centerJ, dir, [finalDepth]
            const arcPoints = linearizeArc(curX, curY, curZ, args);
            for (const pt of arcPoints) {
                entries.push({
                    type: 'M_ARC', x: pt.x, y: pt.y, z: pt.z,
                    raw: null, isMove: true, isJog: false, isCG: true
                });
                if (firstMoveIdx < 0) firstMoveIdx = entries.length - 1;
                lastMoveIdx = entries.length - 1;
                curX = pt.x; curY = pt.y; curZ = pt.z;
            }
            continue;
        }

        if (isMoveCommand(cmd)) {
            const pos = applyMove(cmd, args, curX, curY, curZ);
            const isJog = cmd.startsWith('J');
            if (isJog && pos.z > curZ && pos.z > detectedSafeZ) {
                detectedSafeZ = pos.z;
            }
            entries.push({
                type: cmd, x: pos.x, y: pos.y, z: pos.z,
                raw, isMove: true, isJog, isCG: false
            });
            if (firstMoveIdx < 0) firstMoveIdx = entries.length - 1;
            lastMoveIdx = entries.length - 1;
            curX = pos.x; curY = pos.y; curZ = pos.z;
        } else {
            entries.push({ type: cmd, raw, isMove: false, args });
        }
    }

    // Extract header (everything before first move) and footer (after last move)
    const headerLines = [];
    for (let i = 0; i < firstMoveIdx && i < entries.length; i++) {
        if (entries[i].raw != null) headerLines.push(entries[i].raw);
    }
    const footerLines = [];
    for (let i = lastMoveIdx + 1; i < entries.length; i++) {
        if (entries[i].raw != null) footerLines.push(entries[i].raw);
    }

    // Second pass: group moves into cut paths
    const moveGroups = [];
    let currentGroup = null;
    let state = 'jogging';

    for (const e of entries) {
        if (!e.isMove) continue;

        if (state === 'jogging') {
            if (e.isJog) {
                if (!currentGroup) currentGroup = { moves: [] };
                currentGroup.moves.push({
                    x: e.x, y: e.y, z: e.z, moveType: 'J'
                });
            } else {
                if (!currentGroup) currentGroup = { moves: [] };
                currentGroup.moves.push({
                    x: e.x, y: e.y, z: e.z, moveType: 'F'
                });
                state = 'cutting';
            }
        } else {
            if (e.isJog) {
                currentGroup.moves.push({
                    x: e.x, y: e.y, z: e.z, moveType: 'R'
                });
                moveGroups.push(currentGroup);
                currentGroup = null;
                state = 'jogging';
            } else {
                currentGroup.moves.push({
                    x: e.x, y: e.y, z: e.z, moveType: 'M'
                });
            }
        }
    }

    if (currentGroup && currentGroup.moves.length > 0) {
        moveGroups.push(currentGroup);
    }

    return { moveGroups, headerLines, footerLines, safeZ: detectedSafeZ, rawLines: lines };
}

/**
 * Linearize a CG arc command into small line segments.
 * CG format: CG, clearance, endX, endY, centerOffI, centerOffJ, direction, finalDepth
 * clearance and finalDepth may be empty.
 */
function linearizeArc(startX, startY, startZ, args) {
    const endX = parseArg(args[1], startX);
    const endY = parseArg(args[2], startY);
    const centerI = parseArg(args[3], 0);
    const centerJ = parseArg(args[4], 0);
    const dirStr = (args[5] || '').toUpperCase();
    // In ShopBot CG, -1 means "no helical interpolation" (stay at current Z)
    const rawDepth = parseArg(args[6], -1);
    const finalDepth = (rawDepth === -1) ? startZ : rawDepth;

    // Center is relative to start
    const cx = startX + centerI;
    const cy = startY + centerJ;

    const r = Math.sqrt(centerI * centerI + centerJ * centerJ);
    if (r < 1e-9) {
        // Degenerate arc — just move to end
        return [{ x: endX, y: endY, z: finalDepth }];
    }

    // Start and end angles
    let startAngle = Math.atan2(startY - cy, startX - cx);
    let endAngle = Math.atan2(endY - cy, endX - cx);

    // ShopBot convention: T = CW from above table = increasing angle in standard math
    const increasing = (dirStr === 'T' || dirStr === '1');

    // Calculate sweep
    let sweep;
    if (increasing) {
        sweep = endAngle - startAngle;
        if (sweep <= 0) sweep += 2 * Math.PI;
    } else {
        sweep = startAngle - endAngle;
        if (sweep <= 0) sweep += 2 * Math.PI;
        sweep = -sweep; // negative for decreasing angle direction
    }

    const stepRad = (ARC_STEP_DEG * Math.PI) / 180;
    const numSteps = Math.max(1, Math.ceil(Math.abs(sweep) / stepRad));
    const points = [];

    for (let s = 1; s <= numSteps; s++) {
        const t = s / numSteps;
        const angle = startAngle + sweep * t;
        let x, y;
        if (s === numSteps) {
            // Use exact endpoint to avoid floating point drift
            x = endX;
            y = endY;
        } else {
            x = cx + r * Math.cos(angle);
            y = cy + r * Math.sin(angle);
        }
        // Interpolate Z for helical arcs
        const z = startZ + (finalDepth - startZ) * t;
        points.push({ x, y, z });
    }

    return points;
}

function isMoveCommand(cmd) {
    return ['M2', 'M3', 'M4', 'M5', 'MX', 'MY', 'MZ',
            'J2', 'J3', 'J4', 'J5', 'JX', 'JY', 'JZ',
            'MA', 'MB', 'JA', 'JB'].includes(cmd);
}

function applyMove(cmd, args, curX, curY, curZ) {
    let x = curX, y = curY, z = curZ;
    switch (cmd) {
        case 'M2': case 'J2':
            x = parseArg(args[0], curX); y = parseArg(args[1], curY); break;
        case 'M3': case 'J3':
            x = parseArg(args[0], curX); y = parseArg(args[1], curY); z = parseArg(args[2], curZ); break;
        case 'M5': case 'J5':
            x = parseArg(args[0], curX); y = parseArg(args[1], curY); z = parseArg(args[2], curZ); break;
        case 'MX': case 'JX':
            x = parseArg(args[0], curX); break;
        case 'MY': case 'JY':
            y = parseArg(args[0], curY); break;
        case 'MZ': case 'JZ':
            z = parseArg(args[0], curZ); break;
        case 'M4': case 'J4':
            x = parseArg(args[0], curX); y = parseArg(args[1], curY); z = parseArg(args[2], curZ); break;
    }
    return { x, y, z };
}

function parseArg(val, fallback) {
    if (val === undefined || val === '') return fallback;
    const n = parseFloat(val);
    return isNaN(n) ? fallback : n;
}
