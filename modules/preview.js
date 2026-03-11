// preview.js — 2D canvas preview with animated knife blade simulation

const COLORS = {
    jog: '#666666',
    cut: '#4a9eff',
    lift: '#ff6b6b',
    blade: '#ffa500',
    bladeBody: '#e0e0e0',
    pivot: '#ff3333',
    trail: '#2a6abf',
    uncut: { dark: '#444850', light: '#c0c4c8' },
    upcoming: '#333840',
    background: { dark: '#1d1d1f', light: '#ffffff' },
    grid: { dark: '#2d2d30', light: '#e8e8ed' },
    gridText: { dark: '#555', light: '#aaa' }
};

const RAD2DEG = 180 / Math.PI;

let canvas, ctx;
let viewState = {
    offsetX: 0, offsetY: 0, scale: 1,
    isDragging: false, lastMouse: { x: 0, y: 0 }
};

let cachedPaths = null;
let isDarkMode = true;

// Animation state
let animData = null;    // { waypoints: [{x,y,z,angle,isJog,isLift}...], bladeWidth }
let animState = null;   // { playing, progress, speed, rafId }
let lastFrameTime = 0;
let onProgressUpdate = null; // callback for UI slider sync

export function initPreview(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', () => { resizeCanvas(); draw(); });

    canvas.addEventListener('mousedown', (e) => {
        viewState.isDragging = true;
        viewState.lastMouse = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('mousemove', (e) => {
        if (!viewState.isDragging) return;
        viewState.offsetX += e.clientX - viewState.lastMouse.x;
        viewState.offsetY += e.clientY - viewState.lastMouse.y;
        viewState.lastMouse = { x: e.clientX, y: e.clientY };
        draw();
    });
    canvas.addEventListener('mouseup', () => { viewState.isDragging = false; });
    canvas.addEventListener('mouseleave', () => { viewState.isDragging = false; });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const newScale = viewState.scale * factor;
        viewState.offsetX = mx - (mx - viewState.offsetX) * (newScale / viewState.scale);
        viewState.offsetY = my - (my - viewState.offsetY) * (newScale / viewState.scale);
        viewState.scale = newScale;
        draw();
    }, { passive: false });

    draw();
}

export function setTheme(dark) { isDarkMode = dark; draw(); }
export function setProgressCallback(cb) { onProgressUpdate = cb; }

export function zoomIn() {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    viewState.offsetX = cx - (cx - viewState.offsetX) * 1.3;
    viewState.offsetY = cy - (cy - viewState.offsetY) * 1.3;
    viewState.scale *= 1.3;
    draw();
}

export function zoomOut() {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    viewState.offsetX = cx - (cx - viewState.offsetX) * 0.77;
    viewState.offsetY = cy - (cy - viewState.offsetY) * 0.77;
    viewState.scale *= 0.77;
    draw();
}

export function zoomFit() {
    if (!cachedPaths) return;
    fitView(cachedPaths.bounds);
    draw();
}

function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
}

// --- Static path display (for input files) ---

export function showPaths(moveGroups, mode) {
    stopAnimation();
    const segments = [];
    let bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

    for (const group of moveGroups) {
        const moves = group.moves;
        for (let i = 0; i < moves.length - 1; i++) {
            const a = moves[i], b = moves[i + 1];
            const color = (a.moveType === 'J' || a.moveType === 'R') ? COLORS.jog : COLORS.cut;
            segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color });
            updateBounds(bounds, a.x, a.y);
            updateBounds(bounds, b.x, b.y);
        }
    }

    cachedPaths = { segments, bounds, mode: 'input' };
    animData = null;
    animState = null;
    fitView(bounds);
    draw();
}

// --- Processed output: build animation data ---

export function showProcessedPaths(outputLines, bladeWidth) {
    stopAnimation();

    const waypoints = [];
    let bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    let cx = 0, cy = 0, cz = 0, cAngle = 0;

    for (const line of outputLines) {
        const trimmed = line.trim();
        const commentIdx = trimmed.indexOf("'");
        const codePart = commentIdx >= 0 ? trimmed.substring(0, commentIdx).trim() : trimmed;
        const parts = codePart.split(',');
        const cmd = parts[0].toUpperCase();
        const comment = commentIdx >= 0 ? trimmed.substring(commentIdx + 1).trim() : '';

        let nx = cx, ny = cy, nz = cz;
        let isJog = false, isLift = false;

        if (cmd === 'M2' || cmd === 'J2') {
            nx = pf(parts[1], cx); ny = pf(parts[2], cy);
            isJog = cmd.startsWith('J');
        } else if (cmd === 'M3' || cmd === 'J3') {
            nx = pf(parts[1], cx); ny = pf(parts[2], cy); nz = pf(parts[3], cz);
            isJog = cmd.startsWith('J');
        } else if (cmd === 'M5' || cmd === 'J5') {
            nx = pf(parts[1], cx); ny = pf(parts[2], cy); nz = pf(parts[3], cz);
            cAngle = pf(parts[5], cAngle);
            isJog = cmd.startsWith('J');
        } else if (cmd === 'MZ' || cmd === 'JZ') {
            nz = pf(parts[1], cz);
            isJog = cmd.startsWith('J');
        } else if (cmd === 'JB' || cmd === 'MB') {
            cAngle = pf(parts[1], cAngle);
            // Keep JB during lift as a waypoint so we animate the rotation
            if (comment.includes('Rotate during lift')) {
                waypoints.push({ x: cx, y: cy, z: cz, angle: cAngle, isJog: false, isLift: true });
            }
            continue;
        } else {
            continue;
        }

        isLift = comment.includes('Lifting') || comment.includes('Plunge back')
              || comment.includes('Lifting at cut finish');

        waypoints.push({ x: nx, y: ny, z: nz, angle: cAngle, isJog, isLift });
        updateBounds(bounds, nx, ny);
        cx = nx; cy = ny; cz = nz;
    }

    // Precompute cumulative distances for animation timing
    // Lift waypoints get a fixed dwell so the animation pauses visibly
    const LIFT_DWELL = 0.5; // virtual inches of dwell per lift waypoint
    let totalDist = 0;
    const cumDist = [0];
    for (let i = 1; i < waypoints.length; i++) {
        const dx = waypoints[i].x - waypoints[i - 1].x;
        const dy = waypoints[i].y - waypoints[i - 1].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (waypoints[i].isLift) {
            totalDist += LIFT_DWELL;
        } else if (waypoints[i].isJog) {
            totalDist += d * 0.1;
        } else {
            totalDist += d;
        }
        cumDist.push(totalDist);
    }

    // Build static segments for background drawing
    const segments = [];
    for (let i = 1; i < waypoints.length; i++) {
        const a = waypoints[i - 1], b = waypoints[i];
        let color = b.isJog ? COLORS.jog : COLORS.cut;
        if (b.isLift) color = COLORS.lift;
        if (a.x !== b.x || a.y !== b.y) {
            segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color });
        }
    }

    cachedPaths = { segments, bounds, mode: 'output' };
    animData = { waypoints, cumDist, totalDist, bladeWidth: bladeWidth || 0.1 };
    animState = { playing: false, progress: 0, speed: 1 };
    fitView(bounds);
    draw();
}

// --- Animation controls ---

export function playAnimation() {
    if (!animData || !animState) return;
    animState.playing = true;
    lastFrameTime = performance.now();
    animState.rafId = requestAnimationFrame(animFrame);
}

export function pauseAnimation() {
    if (!animState) return;
    animState.playing = false;
    if (animState.rafId) cancelAnimationFrame(animState.rafId);
}

export function stopAnimation() {
    if (!animState) return;
    animState.playing = false;
    animState.progress = 0;
    if (animState.rafId) cancelAnimationFrame(animState.rafId);
    draw();
}

export function setAnimProgress(p) {
    if (!animState) return;
    animState.progress = Math.max(0, Math.min(1, p));
    draw();
}

/** Map raw slider value (1–100) to actual speed (0.25–15 in/s). */
export function sliderToSpeed(s) {
    return 0.25 + (s - 1) * (15 - 0.25) / 99;
}

export function setAnimSpeed(s) {
    if (!animState) return;
    animState.speed = sliderToSpeed(s);
}

export function isAnimating() {
    return animState && animState.playing;
}

function animFrame(now) {
    if (!animState || !animState.playing) return;

    const dt = (now - lastFrameTime) / 1000; // seconds
    lastFrameTime = now;

    // Advance progress: speed is in inches/sec of toolpath, normalized to total distance
    const advance = (animState.speed * dt) / (animData.totalDist || 1);
    animState.progress += advance;

    if (animState.progress >= 1) {
        animState.progress = 1;
        animState.playing = false;
        draw();
        if (onProgressUpdate) onProgressUpdate(1);
        return;
    }

    draw();
    if (onProgressUpdate) onProgressUpdate(animState.progress);
    animState.rafId = requestAnimationFrame(animFrame);
}

// --- Interpolate position at progress t ---

function getPositionAtProgress(t) {
    if (!animData) return null;
    const { waypoints, cumDist, totalDist } = animData;
    const targetDist = t * totalDist;

    // Binary search for segment
    let lo = 0, hi = cumDist.length - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cumDist[mid] <= targetDist) lo = mid; else hi = mid;
    }

    const segStart = cumDist[lo];
    const segEnd = cumDist[hi];
    const segLen = segEnd - segStart;
    const frac = segLen > 0 ? (targetDist - segStart) / segLen : 0;

    const a = waypoints[lo], b = waypoints[hi];
    return {
        x: a.x + (b.x - a.x) * frac,
        y: a.y + (b.y - a.y) * frac,
        z: a.z + (b.z - a.z) * frac,
        angle: a.angle + (b.angle - a.angle) * frac,
        isJog: b.isJog,
        isLift: b.isLift,
        segIndex: hi,
        segStart: lo
    };
}

// --- Drawing ---

function draw() {
    if (!ctx) return;
    const w = canvas.width / window.devicePixelRatio;
    const h = canvas.height / window.devicePixelRatio;

    ctx.fillStyle = isDarkMode ? COLORS.background.dark : COLORS.background.light;
    ctx.fillRect(0, 0, w, h);
    drawGrid(w, h);

    if (!cachedPaths) return;

    const isAnimMode = animData && animState;

    if (isAnimMode) {
        drawAnimated();
    } else {
        drawStatic();
    }
}

function drawStatic() {
    const { segments } = cachedPaths;

    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 4]);
    for (const seg of segments) {
        if (seg.color === COLORS.jog) drawSegment(seg);
    }

    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    for (const seg of segments) {
        if (seg.color === COLORS.lift) drawSegment(seg);
    }

    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    for (const seg of segments) {
        if (seg.color === COLORS.cut) drawSegment(seg);
    }
}

function drawAnimated() {
    const { waypoints } = animData;
    const pos = getPositionAtProgress(animState.progress);
    if (!pos) return;

    const segIdx = pos.segIndex;
    const uncutColor = isDarkMode ? COLORS.uncut.dark : COLORS.uncut.light;

    // 1) Draw full uncut toolpath in grey
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeStyle = uncutColor;
    for (let i = 1; i < waypoints.length; i++) {
        const a = waypoints[i - 1], b = waypoints[i];
        if (a.x === b.x && a.y === b.y) continue;
        if (b.isJog) {
            // Jogs stay dashed grey regardless
            ctx.lineWidth = 0.5;
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = COLORS.jog;
        } else {
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.strokeStyle = uncutColor;
        }
        ctx.beginPath();
        ctx.moveTo(toScreenX(a.x), toScreenY(a.y));
        ctx.lineTo(toScreenX(b.x), toScreenY(b.y));
        ctx.stroke();
    }

    // 2) Overlay completed segments in blue (or lift color)
    for (let i = 1; i <= segIdx && i < waypoints.length; i++) {
        const a = waypoints[i - 1], b = waypoints[i];
        if (a.x === b.x && a.y === b.y) continue;
        if (b.isJog) continue; // jogs already drawn above
        if (b.isLift) {
            ctx.strokeStyle = COLORS.lift;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
        } else {
            ctx.strokeStyle = COLORS.cut;
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
        }
        ctx.beginPath();
        ctx.moveTo(toScreenX(a.x), toScreenY(a.y));
        ctx.lineTo(toScreenX(b.x), toScreenY(b.y));
        ctx.stroke();
    }

    // 3) Partial current segment (from segStart to interpolated pos)
    if (pos.segStart >= 0 && pos.segIndex < waypoints.length) {
        const from = waypoints[pos.segStart];
        if (!pos.isJog && (from.x !== pos.x || from.y !== pos.y)) {
            ctx.strokeStyle = COLORS.cut;
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(toScreenX(from.x), toScreenY(from.y));
            ctx.lineTo(toScreenX(pos.x), toScreenY(pos.y));
            ctx.stroke();
        }
    }
    ctx.setLineDash([]);

    // Draw knife blade at current position
    drawBlade(pos.x, pos.y, pos.angle, pos.isJog, pos.isLift);
}

function drawBlade(x, y, angleDeg, isJog, isLift) {
    if (isJog) {
        // Just draw a small dot for jog position
        const sx = toScreenX(x), sy = toScreenY(y);
        ctx.fillStyle = COLORS.jog;
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fill();
        return;
    }

    const sx = toScreenX(x), sy = toScreenY(y);
    const rad = -angleDeg / RAD2DEG; // convert to math radians

    // Blade dimensions in screen pixels
    const bladeLen = Math.max(12, Math.min(40, animData.bladeWidth * viewState.scale * 3));
    const bladeHalfW = Math.max(2, bladeLen * 0.12);

    // Blade extends forward (cutting direction) from pivot
    const tipX = sx + Math.cos(rad) * bladeLen;
    const tipY = sy - Math.sin(rad) * bladeLen;

    // Blade body (narrow rectangle from pivot to just before tip)
    const perpX = Math.sin(rad) * bladeHalfW;
    const perpY = Math.cos(rad) * bladeHalfW;

    if (isLift) {
        // Lifted state — blade drawn raised with lift color and glow ring
        const glowRadius = bladeLen * 0.8;
        const gradient = ctx.createRadialGradient(sx, sy, 2, sx, sy, glowRadius);
        gradient.addColorStop(0, 'rgba(255, 107, 107, 0.25)');
        gradient.addColorStop(1, 'rgba(255, 107, 107, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(sx, sy, glowRadius, 0, Math.PI * 2);
        ctx.fill();

        // Blade body — translucent lift color
        ctx.fillStyle = COLORS.lift;
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(sx + perpX, sy + perpY);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(sx - perpX, sy - perpY);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1.0;

        // Blade outline — lift color
        ctx.strokeStyle = COLORS.lift;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(sx + perpX, sy + perpY);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(sx - perpX, sy - perpY);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);

        // Pivot point — lift color
        ctx.fillStyle = COLORS.lift;
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Up arrow indicator
        ctx.fillStyle = COLORS.lift;
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('\u2191', sx, sy - bladeLen - 4);
        return;
    }

    // Normal cutting state
    ctx.fillStyle = COLORS.bladeBody;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(sx + perpX, sy + perpY);
    ctx.lineTo(tipX, tipY); // pointed tip
    ctx.lineTo(sx - perpX, sy - perpY);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Blade outline
    ctx.strokeStyle = COLORS.blade;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx + perpX, sy + perpY);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(sx - perpX, sy - perpY);
    ctx.closePath();
    ctx.stroke();

    // Cutting edge highlight (front edge)
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx + perpX, sy + perpY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // Pivot point
    ctx.fillStyle = COLORS.pivot;
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawSegment(seg) {
    ctx.strokeStyle = seg.color;
    ctx.beginPath();
    ctx.moveTo(toScreenX(seg.x1), toScreenY(seg.y1));
    ctx.lineTo(toScreenX(seg.x2), toScreenY(seg.y2));
    ctx.stroke();
}

function drawGrid(w, h) {
    const rawSpacing = 50 / viewState.scale;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawSpacing)));
    let spacing;
    if (rawSpacing / magnitude < 2) spacing = magnitude;
    else if (rawSpacing / magnitude < 5) spacing = 2 * magnitude;
    else spacing = 5 * magnitude;

    const theme = isDarkMode ? 'dark' : 'light';
    ctx.strokeStyle = COLORS.grid[theme];
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = COLORS.gridText[theme];

    const dataLeft = Math.min(fromScreenX(0), fromScreenX(w));
    const dataRight = Math.max(fromScreenX(0), fromScreenX(w));
    const dataBottom = Math.min(fromScreenY(0), fromScreenY(h));
    const dataTop = Math.max(fromScreenY(0), fromScreenY(h));

    const startX = Math.floor(dataLeft / spacing) * spacing;
    const startY = Math.floor(dataBottom / spacing) * spacing;

    for (let x = startX; x <= dataRight; x += spacing) {
        const sx = toScreenX(x);
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
        ctx.fillText(x.toFixed(spacing < 1 ? 2 : spacing < 10 ? 1 : 0), sx + 2, h - 4);
    }
    for (let y = startY; y <= dataTop; y += spacing) {
        const sy = toScreenY(y);
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
        ctx.fillText(y.toFixed(spacing < 1 ? 2 : spacing < 10 ? 1 : 0), 4, sy - 4);
    }
}

function fitView(bounds) {
    if (!bounds || bounds.minX === Infinity) return;
    const pad = 40;
    const w = canvas.width / window.devicePixelRatio - pad * 2;
    const h = canvas.height / window.devicePixelRatio - pad * 2;
    const dataW = bounds.maxX - bounds.minX || 1;
    const dataH = bounds.maxY - bounds.minY || 1;
    viewState.scale = Math.min(w / dataW, h / dataH);
    viewState.offsetX = pad + (w - dataW * viewState.scale) / 2 - bounds.minX * viewState.scale;
    viewState.offsetY = pad + (h - dataH * viewState.scale) / 2 + bounds.maxY * viewState.scale;
}

function toScreenX(x) { return x * viewState.scale + viewState.offsetX; }
function toScreenY(y) { return -y * viewState.scale + viewState.offsetY; }
function fromScreenX(sx) { return (sx - viewState.offsetX) / viewState.scale; }
function fromScreenY(sy) { return -(sy - viewState.offsetY) / viewState.scale; }

function updateBounds(b, x, y) {
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
}

function pf(val, fallback) {
    if (val === undefined || val === '') return fallback;
    const n = parseFloat(val);
    return isNaN(n) ? fallback : n;
}

export function clearPreview() {
    stopAnimation();
    cachedPaths = null;
    animData = null;
    animState = null;
    draw();
}
