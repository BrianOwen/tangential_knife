// main.js — Tangential Knife Processor

import { parseSBP } from './modules/parser.js';
import { processFile } from './modules/processor.js';
import { parseSVGFile, parseDXFFile } from './modules/vector-import.js';
import { convertPathsToMoveGroups } from './modules/vector-to-movegroups.js';
import {
    initPreview, showPaths, showProcessedPaths, clearPreview,
    setTheme, zoomIn, zoomOut, zoomFit,
    playAnimation, pauseAnimation, stopAnimation,
    setAnimProgress, setAnimSpeed, sliderToSpeed, setProgressCallback, isAnimating,
    setOrigin, getOrigin, setOriginCallback, setVectorBounds
} from './modules/preview.js';

let fileText = null;
let parsedFile = null;      // SBP mode: from parseSBP()
let vectorPaths = null;     // Vector mode: { paths, bounds }
let selectedPathIds = new Set();
let processedOutput = null;
let fileName = '';
let mode = null;            // 'sbp' or 'vector'

document.addEventListener('DOMContentLoaded', init);

function init() {
    initPreview(document.getElementById('previewCanvas'));
    setupEventListeners();
    setStatus('Ready — load a file to begin');
}

function setupEventListeners() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');

    // File drag & drop
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) handleFile(e.target.files[0]);
    });

    // Clear file
    document.getElementById('clearFileBtn').addEventListener('click', clearFile);

    // Process
    document.getElementById('processBtn').addEventListener('click', doProcess);

    // Download
    document.getElementById('downloadBtn').addEventListener('click', doDownload);

    // Canvas controls
    document.getElementById('zoomInBtn').addEventListener('click', zoomIn);
    document.getElementById('zoomOutBtn').addEventListener('click', zoomOut);
    document.getElementById('zoomFitBtn').addEventListener('click', zoomFit);

    // Theme
    document.getElementById('themeToggle').addEventListener('click', () => {
        const isDark = document.body.classList.toggle('dark-mode');
        document.body.classList.toggle('light-mode', !isDark);
        setTheme(isDark);
    });

    // Animation controls
    const playBtn = document.getElementById('playBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const progressSlider = document.getElementById('progressSlider');
    const progressPct = document.getElementById('progressPct');
    const speedSlider = document.getElementById('speedSlider');
    const speedValue = document.getElementById('speedValue');

    playBtn.addEventListener('click', () => {
        playAnimation();
        playBtn.classList.add('hidden');
        pauseBtn.classList.remove('hidden');
    });

    pauseBtn.addEventListener('click', () => {
        pauseAnimation();
        pauseBtn.classList.add('hidden');
        playBtn.classList.remove('hidden');
    });

    stopBtn.addEventListener('click', () => {
        stopAnimation();
        pauseBtn.classList.add('hidden');
        playBtn.classList.remove('hidden');
        progressSlider.value = 0;
        progressPct.textContent = '0%';
    });

    progressSlider.addEventListener('input', () => {
        const p = parseInt(progressSlider.value) / 1000;
        setAnimProgress(p);
        progressPct.textContent = Math.round(p * 100) + '%';
    });

    speedSlider.addEventListener('input', () => {
        const s = parseInt(speedSlider.value);
        setAnimSpeed(s);
        speedValue.textContent = sliderToSpeed(s).toFixed(1);
    });

    // Initialize speed from slider default
    setAnimSpeed(parseInt(speedSlider.value));
    speedValue.textContent = sliderToSpeed(parseInt(speedSlider.value)).toFixed(1);

    // Sync progress slider from animation playback
    setProgressCallback((p) => {
        progressSlider.value = Math.round(p * 1000);
        progressPct.textContent = Math.round(p * 100) + '%';
        if (p >= 1) {
            pauseBtn.classList.add('hidden');
            playBtn.classList.remove('hidden');
        }
    });

    // Vector path selection
    document.getElementById('selectAllPaths').addEventListener('click', () => {
        if (!vectorPaths) return;
        selectedPathIds = new Set(vectorPaths.paths.map(p => p.id));
        renderPathList();
        showVectorPreview();
    });
    document.getElementById('deselectAllPaths').addEventListener('click', () => {
        selectedPathIds.clear();
        renderPathList();
        showVectorPreview();
    });

    // Default cut depth applies to all paths
    document.getElementById('cutDepth').addEventListener('change', applyDefaultDepth);

    // Origin inputs ↔ canvas crosshair
    const originXInput = document.getElementById('originX');
    const originYInput = document.getElementById('originY');
    originXInput.addEventListener('change', () => {
        const x = readNumericInput('originX', 0);
        const y = readNumericInput('originY', 0);
        setOrigin(x, y);
    });
    originYInput.addEventListener('change', () => {
        const x = readNumericInput('originX', 0);
        const y = readNumericInput('originY', 0);
        setOrigin(x, y);
    });
    setOriginCallback((x, y) => {
        originXInput.value = x.toFixed(3);
        originYInput.value = y.toFixed(3);
    });
}

// ── File handling ──

async function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'sbp') {
        await handleSBPFile(file);
    } else if (ext === 'svg' || ext === 'dxf') {
        await handleVectorFile(file, ext);
    } else {
        setStatus('Unsupported file type. Use .sbp, .svg, or .dxf');
        return;
    }
}

async function handleSBPFile(file) {
    fileName = file.name;
    mode = 'sbp';
    setStatus('Reading file...');

    try {
        fileText = await file.text();
        parsedFile = parseSBP(fileText);
        vectorPaths = null;
        processedOutput = null;
        setVectorBounds(null);

        // Update UI
        showFileInfo('SBP');
        setModeUI('sbp');

        // Auto-detect safe Z from file
        const safeZInput = document.getElementById('safeZ');
        const detectedSafe = parsedFile.safeZ;
        if (detectedSafe > 0) {
            safeZInput.value = detectedSafe.toFixed(3);
        }

        // Show input toolpath preview
        document.getElementById('playbackBar').classList.add('hidden');
        showPaths(parsedFile.moveGroups, 'input');

        const nGroups = parsedFile.moveGroups.length;
        const nMoves = parsedFile.moveGroups.reduce((s, g) => s + g.moves.length, 0);
        setStatus(`Loaded: ${nGroups} cut path${nGroups !== 1 ? 's' : ''}, ${nMoves} moves`);
    } catch (err) {
        setStatus('Error reading file: ' + err.message);
        console.error(err);
    }
}

async function handleVectorFile(file, ext) {
    fileName = file.name;
    mode = 'vector';
    setStatus('Parsing vectors...');

    try {
        const text = await file.text();

        if (ext === 'svg') {
            vectorPaths = parseSVGFile(text);
        } else {
            vectorPaths = parseDXFFile(text);
        }

        parsedFile = null;
        processedOutput = null;
        setVectorBounds(vectorPaths.bounds);

        // Initialize per-path cut settings from default
        const defaultDepth = readNumericInput('cutDepth', 0.125);
        for (const p of vectorPaths.paths) {
            p.cutDepth = defaultDepth;
            p.passes = 1;
        }

        // Select all paths by default
        selectedPathIds = new Set(vectorPaths.paths.map(p => p.id));

        // Update UI
        showFileInfo('Vector');
        setModeUI('vector');
        renderPathList();

        // Show preview
        document.getElementById('playbackBar').classList.add('hidden');
        showVectorPreview();

        const nPaths = vectorPaths.paths.length;
        const nClosed = vectorPaths.paths.filter(p => p.isClosed).length;
        const nOpen = nPaths - nClosed;
        setStatus(`Imported: ${nPaths} path${nPaths !== 1 ? 's' : ''} (${nClosed} closed, ${nOpen} open)`);
    } catch (err) {
        setStatus('Import error: ' + err.message);
        console.error(err);
    }
}

function showFileInfo(modeLabel) {
    document.getElementById('fileName').textContent = fileName;
    document.getElementById('fileMode').textContent = modeLabel;
    document.getElementById('fileInfo').classList.remove('hidden');
    document.getElementById('dropZone').style.display = 'none';
    document.getElementById('processBtn').disabled = false;
    document.getElementById('downloadBtn').disabled = true;
    document.getElementById('statsSection').classList.add('hidden');
}

function setModeUI(m) {
    // Show/hide vector-only sections
    document.querySelectorAll('.vector-only').forEach(el => {
        el.classList.toggle('hidden', m !== 'vector');
    });
}

function clearFile() {
    fileText = null;
    parsedFile = null;
    vectorPaths = null;
    selectedPathIds.clear();
    processedOutput = null;
    fileName = '';
    mode = null;

    document.getElementById('fileInfo').classList.add('hidden');
    document.getElementById('dropZone').style.display = '';
    document.getElementById('processBtn').disabled = true;
    document.getElementById('downloadBtn').disabled = true;
    document.getElementById('statsSection').classList.add('hidden');
    document.getElementById('fileInput').value = '';
    setModeUI(null);

    clearPreview();
    setVectorBounds(null);
    setOrigin(0, 0);
    document.getElementById('originX').value = '0';
    document.getElementById('originY').value = '0';
    document.getElementById('playbackBar').classList.add('hidden');
    setStatus('Ready — load a file to begin');
}

// ── Vector path list ──

const PATH_COLORS = ['#4a9eff', '#ff6b6b', '#44cc44', '#ffa500', '#cc44cc', '#44cccc', '#ffcc00', '#ff44aa'];

function renderPathList() {
    const list = document.getElementById('pathList');
    const countEl = document.getElementById('pathCount');
    if (!vectorPaths) { list.innerHTML = ''; return; }

    const paths = vectorPaths.paths;
    countEl.textContent = `(${selectedPathIds.size} / ${paths.length})`;

    list.innerHTML = `<div class="path-list-header">
        <span class="path-header-spacer"></span>
        <span class="path-col-label">depth</span>
        <span class="path-unit"></span>
        <span class="path-x"></span>
        <span class="path-col-label">passes</span>
    </div>` + paths.map(p => {
        const checked = selectedPathIds.has(p.id) ? 'checked' : '';
        const cls = selectedPathIds.has(p.id) ? '' : ' deselected';
        const color = PATH_COLORS[p.id % PATH_COLORS.length];
        const type = p.isClosed ? 'closed' : 'open';
        return `<div class="path-item${cls}" data-pid="${p.id}">
            <input type="checkbox" ${checked} data-pid="${p.id}">
            <span class="path-color" style="background:${color}"></span>
            <span class="path-label">Path ${p.id + 1} <small>${type}</small></span>
            <input type="number" class="path-depth" value="${p.cutDepth}" step="0.0625" min="0.001"
                   data-pid="${p.id}" data-field="cutDepth" title="Cut depth (in)">
            <span class="path-unit">in</span>
            <span class="path-x">&times;</span>
            <input type="number" class="path-passes" value="${p.passes}" step="1" min="1" max="50"
                   data-pid="${p.id}" data-field="passes" title="Number of passes">
        </div>`;
    }).join('');

    // Checkbox events
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            const pid = parseInt(cb.dataset.pid);
            if (cb.checked) selectedPathIds.add(pid);
            else selectedPathIds.delete(pid);
            renderPathList();
            showVectorPreview();
        });
    });

    // Per-path depth/passes events
    list.querySelectorAll('input[type="number"]').forEach(inp => {
        inp.addEventListener('change', () => {
            const pid = parseInt(inp.dataset.pid);
            const field = inp.dataset.field;
            const path = vectorPaths.paths.find(p => p.id === pid);
            if (!path) return;
            const val = parseFloat(inp.value);
            if (isNaN(val) || val <= 0) return;
            path[field] = field === 'passes' ? Math.round(val) : val;
        });
        // Stop click from toggling the checkbox
        inp.addEventListener('click', e => e.stopPropagation());
    });

    document.getElementById('processBtn').disabled = selectedPathIds.size === 0;
}

/** When the default cut depth changes, apply to all paths that haven't been individually edited. */
function applyDefaultDepth() {
    if (!vectorPaths) return;
    const depth = readNumericInput('cutDepth', 0.125);
    for (const p of vectorPaths.paths) {
        p.cutDepth = depth;
    }
    renderPathList();
}

/** Show vector paths on canvas using the existing showPaths preview. */
function showVectorPreview() {
    if (!vectorPaths) return;
    const safeZ = readNumericInput('safeZ', 0.5);

    const allGroups = [];
    for (const path of vectorPaths.paths) {
        const isSelected = selectedPathIds.has(path.id);
        const pts = path.points;
        if (pts.length < 2) continue;

        const zCut = -Math.abs(path.cutDepth || 0.125);
        const moves = [];
        moves.push({ x: pts[0].x, y: pts[0].y, z: safeZ, moveType: 'J' });
        moves.push({ x: pts[0].x, y: pts[0].y, z: zCut, moveType: 'F' });
        for (let i = 1; i < pts.length; i++) {
            moves.push({ x: pts[i].x, y: pts[i].y, z: zCut, moveType: 'M' });
        }
        if (path.isClosed) {
            moves.push({ x: pts[0].x, y: pts[0].y, z: zCut, moveType: 'M' });
        }
        const lastPt = path.isClosed ? pts[0] : pts[pts.length - 1];
        moves.push({ x: lastPt.x, y: lastPt.y, z: safeZ, moveType: 'R' });

        const group = { moves };
        if (!isSelected) group._dimmed = true;
        allGroups.push(group);
    }

    showPaths(allGroups, 'input');
}

// ── Process ──

async function doProcess() {
    if (mode === 'sbp') {
        await doProcessSBP();
    } else if (mode === 'vector') {
        await doProcessVector();
    }
}

async function doProcessSBP() {
    if (!parsedFile) return;

    const bladeWidth = readNumericInput('bladeWidth', 0.1);
    const pulloutAngle = readNumericInput('pulloutAngle', 120);
    const safeZ = readNumericInput('safeZ', 0.5);

    if (bladeWidth <= 0) { setStatus('Error: Blade width must be positive'); return; }
    if (pulloutAngle <= 0) { setStatus('Error: Pullout angle must be positive'); return; }

    setStatus('Processing...');
    showLoading(true, 'Applying tangential knife logic...');
    await new Promise(r => setTimeout(r, 50));

    try {
        const { outputLines, stats } = processFile(parsedFile.moveGroups, {
            bladeWidth, pulloutAngle, safeZ
        });

        // Build complete output file with knife-specific header
        const knifeHeader = buildKnifeHeader(parsedFile, { bladeWidth, pulloutAngle, safeZ });
        const knifeFooter = buildKnifeFooter(safeZ);
        const fullOutput = [...knifeHeader, ...outputLines, ...knifeFooter];
        processedOutput = fullOutput.join('\r\n');

        // Show processed preview with animation
        showProcessedPaths(outputLines, bladeWidth);
        document.getElementById('playbackBar').classList.remove('hidden');
        document.getElementById('progressSlider').value = 0;
        document.getElementById('progressPct').textContent = '0%';

        showStats(stats, outputLines.length);
        document.getElementById('downloadBtn').disabled = false;
        setStatus(`Processed: ${stats.cutPaths} paths, ${stats.lifts} blade lifts added`);
    } catch (err) {
        setStatus('Processing error: ' + err.message);
        console.error(err);
    } finally {
        showLoading(false);
    }
}

async function doProcessVector() {
    if (!vectorPaths || selectedPathIds.size === 0) return;

    const bladeWidth = readNumericInput('bladeWidth', 0.1);
    const pulloutAngle = readNumericInput('pulloutAngle', 120);
    const safeZ = readNumericInput('safeZ', 0.5);
    const feedRate = readNumericInput('feedRate', 5.0);
    const plungeRate = readNumericInput('plungeRate', 3.0);

    if (bladeWidth <= 0) { setStatus('Error: Blade width must be positive'); return; }

    // Filter to selected paths only
    const selected = vectorPaths.paths.filter(p => selectedPathIds.has(p.id));

    // Validate that all selected paths have valid depths
    const badPath = selected.find(p => !(p.cutDepth > 0));
    if (badPath) { setStatus(`Error: Path ${badPath.id + 1} has invalid cut depth`); return; }

    setStatus('Processing vectors...');
    showLoading(true, 'Generating tangential knife toolpath...');
    await new Promise(r => setTimeout(r, 50));

    try {
        // Apply origin offset — shift all points so the crosshair becomes 0,0
        const origin = getOrigin();
        const offsetSelected = selected.map(p => ({
            ...p,
            points: p.points.map(pt => ({ x: pt.x - origin.x, y: pt.y - origin.y })),
        }));

        // Convert to moveGroups (depth/passes come from each path object)
        const moveGroups = convertPathsToMoveGroups(offsetSelected, { safeZ });

        // Run through tangential knife processor
        const { outputLines, stats } = processFile(moveGroups, {
            bladeWidth, pulloutAngle, safeZ
        });

        // Build output file
        const depths = selected.map(p => p.cutDepth);
        const minDepth = Math.min(...depths);
        const maxDepth = Math.max(...depths);
        const header = buildVectorKnifeHeader({ bladeWidth, pulloutAngle, safeZ, minDepth, maxDepth, feedRate, plungeRate });
        const footer = buildKnifeFooter(safeZ);
        const fullOutput = [...header, ...outputLines, ...footer];
        processedOutput = fullOutput.join('\r\n');

        // Show processed preview (shift waypoints back to original space for display)
        showProcessedPaths(outputLines, bladeWidth, origin);
        document.getElementById('playbackBar').classList.remove('hidden');
        document.getElementById('progressSlider').value = 0;
        document.getElementById('progressPct').textContent = '0%';

        showStats(stats, outputLines.length);
        document.getElementById('downloadBtn').disabled = false;
        setStatus(`Generated: ${stats.cutPaths} paths, ${stats.lifts} blade lifts, ${outputLines.length} moves`);
    } catch (err) {
        setStatus('Processing error: ' + err.message);
        console.error(err);
    } finally {
        showLoading(false);
    }
}

function showStats(stats, outputCount) {
    document.getElementById('statsSection').classList.remove('hidden');
    document.getElementById('statsGrid').innerHTML = `
        <span class="stat-label">Cut paths</span><span class="stat-value">${stats.cutPaths}</span>
        <span class="stat-label">Blade lifts</span><span class="stat-value">${stats.lifts}</span>
        <span class="stat-label">Output moves</span><span class="stat-value">${outputCount}</span>
    `;
}

// ── Header/footer builders ──

/**
 * Build knife header from an existing SBP file's metadata.
 */
function buildKnifeHeader(parsed, opts) {
    const { bladeWidth, pulloutAngle, safeZ } = opts;

    const metaComments = parsed.headerLines.filter(line => {
        const t = line.trim();
        return t.startsWith("'") && !t.startsWith("'---");
    });

    let unitCheck = "IF %(25)=1 THEN GOTO UNIT_ERROR\t'check to see software is set to standard";
    for (const line of parsed.headerLines) {
        if (line.toUpperCase().includes('IF %(25)')) { unitCheck = line; break; }
    }

    let msLine = `MS,5.0,3.0`;
    for (const line of parsed.headerLines) {
        if (line.trim().toUpperCase().startsWith('MS,')) { msLine = line.trim(); break; }
    }

    return [
        `'Tangential Knife file — processed by ShopBot Labs`,
        `'Blade width: ${bladeWidth} in  |  Max turn: ${pulloutAngle} deg  |  Safe Z: ${safeZ} in`,
        `'Source: ${fileName}`,
        `'Generated: ${new Date().toISOString()}`,
        ...metaComments,
        `'----------------------------------------------------------------`,
        unitCheck,
        `C#,92 'Load Knife Settings`,
        `IF &ATC = 1 Then GoSub EMPTY_SPINDLE`,
        `IF &ATC = 2 Then GoSub EMPTY_SPINDLE`,
        `IF &ATC = 4 Then GoSub EMPTY_SPINDLE`,
        `VO,1,&Knife_X_offset,&Knife_Y_offset 'Knife offsets from C:/sbParts/Custom/KnifeSettings.sbc`,
        `SF,0`,
        `&PWSafeZ = ${safeZ.toFixed(3)}`,
        `JZ,${safeZ.toFixed(6)}`,
        `SO,5,1`,
        `Pause 2`,
        `SO,6,1`,
        msLine,
    ];
}

/**
 * Build knife header for vector-generated toolpaths (no source SBP).
 */
function buildVectorKnifeHeader(opts) {
    const { bladeWidth, pulloutAngle, safeZ, minDepth, maxDepth, feedRate, plungeRate } = opts;

    const depthStr = minDepth === maxDepth
        ? `${minDepth} in`
        : `${minDepth}–${maxDepth} in`;

    return [
        `'Tangential Knife file — generated by ShopBot Labs`,
        `'Source: ${fileName}`,
        `'Blade width: ${bladeWidth} in  |  Max turn: ${pulloutAngle} deg`,
        `'Cut depth: ${depthStr}  |  Feed: ${feedRate} in/s  |  Plunge: ${plungeRate} in/s`,
        `'Safe Z: ${safeZ} in`,
        `'Generated: ${new Date().toISOString()}`,
        `'----------------------------------------------------------------`,
        `IF %(25)=1 THEN GOTO UNIT_ERROR\t'check to see software is set to standard`,
        `C#,92 'Load Knife Settings`,
        `IF &ATC = 1 Then GoSub EMPTY_SPINDLE`,
        `IF &ATC = 2 Then GoSub EMPTY_SPINDLE`,
        `IF &ATC = 4 Then GoSub EMPTY_SPINDLE`,
        `VO,1,&Knife_X_offset,&Knife_Y_offset 'Knife offsets from C:/sbParts/Custom/KnifeSettings.sbc`,
        `SF,0`,
        `&PWSafeZ = ${safeZ.toFixed(3)}`,
        `JZ,${safeZ.toFixed(6)}`,
        `SO,5,1`,
        `Pause 2`,
        `SO,6,1`,
        `MS,${feedRate.toFixed(1)},${plungeRate.toFixed(1)}`,
    ];
}

/**
 * Build knife-specific footer with proper shutdown sequence.
 */
function buildKnifeFooter(safeZ) {
    return [
        `VO,0`,
        `J5,0.000000,0.000000,${safeZ.toFixed(6)},,0`,
        `SO,6,0`,
        `SO,5,0`,
        `END`,
        `EMPTY_SPINDLE:`,
        `C#,89`,
        `IF &ToolIN = 0 Then GOTO ALREADY_EMPTY`,
        `&tool = 0`,
        `C9`,
        `ALREADY_EMPTY:`,
        `Return`,
        `UNIT_ERROR:`,
        `CN, 91                            'Run file explaining unit error`,
        `END`,
    ];
}

// ── Download ──

function doDownload() {
    if (!processedOutput) return;

    let outName;
    if (mode === 'vector') {
        outName = fileName.replace(/\.(svg|dxf)$/i, '_knife.sbp');
    } else {
        outName = fileName.replace(/\.sbp$/i, '_knife.sbp');
    }

    const blob = new Blob([processedOutput], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Downloaded: ${outName}`);
}

// ── Helpers ──

function readNumericInput(id, fallback) {
    const v = parseFloat(document.getElementById(id).value);
    return isNaN(v) ? fallback : v;
}

function setStatus(text) {
    document.getElementById('statusBar').textContent = text;
}

function showLoading(show, text) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) {
        document.getElementById('loadingText').textContent = text || 'Processing...';
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}
