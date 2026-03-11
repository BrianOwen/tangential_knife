// main.js — Tangential Knife Processor

import { parseSBP } from './modules/parser.js';
import { processFile } from './modules/processor.js';
import {
    initPreview, showPaths, showProcessedPaths, clearPreview,
    setTheme, zoomIn, zoomOut, zoomFit,
    playAnimation, pauseAnimation, stopAnimation,
    setAnimProgress, setAnimSpeed, setProgressCallback, isAnimating
} from './modules/preview.js';

let fileText = null;
let parsedFile = null;
let processedOutput = null;
let fileName = '';

document.addEventListener('DOMContentLoaded', init);

function init() {
    initPreview(document.getElementById('previewCanvas'));
    setupEventListeners();
    setStatus('Ready — load a ShopBot file to begin');
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
        speedValue.textContent = s;
    });

    // Initialize speed from slider default
    setAnimSpeed(parseInt(speedSlider.value));

    // Sync progress slider from animation playback
    setProgressCallback((p) => {
        progressSlider.value = Math.round(p * 1000);
        progressPct.textContent = Math.round(p * 100) + '%';
        if (p >= 1) {
            pauseBtn.classList.add('hidden');
            playBtn.classList.remove('hidden');
        }
    });
}

async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.sbp')) {
        setStatus('Error: Please select a .sbp file');
        return;
    }

    fileName = file.name;
    setStatus('Reading file...');

    try {
        fileText = await file.text();
        parsedFile = parseSBP(fileText);
        processedOutput = null;

        // Update UI
        document.getElementById('fileName').textContent = fileName;
        document.getElementById('fileInfo').classList.remove('hidden');
        document.getElementById('dropZone').style.display = 'none';
        document.getElementById('processBtn').disabled = false;
        document.getElementById('downloadBtn').disabled = true;
        document.getElementById('statsSection').classList.add('hidden');

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

function clearFile() {
    fileText = null;
    parsedFile = null;
    processedOutput = null;
    fileName = '';

    document.getElementById('fileInfo').classList.add('hidden');
    document.getElementById('dropZone').style.display = '';
    document.getElementById('processBtn').disabled = true;
    document.getElementById('downloadBtn').disabled = true;
    document.getElementById('statsSection').classList.add('hidden');
    document.getElementById('fileInput').value = '';

    clearPreview();
    document.getElementById('playbackBar').classList.add('hidden');
    setStatus('Ready — load a ShopBot file to begin');
}

async function doProcess() {
    if (!parsedFile) return;

    const bladeWidth = readNumericInput('bladeWidth', 0.1);
    const pulloutAngle = readNumericInput('pulloutAngle', 120);
    const safeZ = readNumericInput('safeZ', 0.5);

    if (bladeWidth <= 0) {
        setStatus('Error: Blade width must be positive');
        return;
    }
    if (pulloutAngle <= 0) {
        setStatus('Error: Pullout angle must be positive');
        return;
    }

    setStatus('Processing...');
    showLoading(true, 'Applying tangential knife logic...');

    // Yield to browser to show loading
    await new Promise(r => setTimeout(r, 50));

    try {
        const { outputLines, stats } = processFile(parsedFile.moveGroups, {
            bladeWidth,
            pulloutAngle,
            safeZ
        });

        // Build complete output file
        const knifeHeader = [
            `'Tangential knife processed`,
            `'Blade width: ${bladeWidth} in`,
            `'Max turn in-material: ${pulloutAngle} deg`,
            `'Safe Z: ${safeZ} in`,
            `'---`
        ];

        const fullOutput = [
            ...parsedFile.headerLines,
            ...knifeHeader,
            ...outputLines,
            ...parsedFile.footerLines
        ];

        processedOutput = fullOutput.join('\r\n');

        // Show processed preview with animation
        showProcessedPaths(outputLines, bladeWidth);
        document.getElementById('playbackBar').classList.remove('hidden');
        document.getElementById('progressSlider').value = 0;
        document.getElementById('progressPct').textContent = '0%';

        // Show stats
        document.getElementById('statsSection').classList.remove('hidden');
        const statsGrid = document.getElementById('statsGrid');
        statsGrid.innerHTML = `
            <span class="stat-label">Cut paths</span><span class="stat-value">${stats.cutPaths}</span>
            <span class="stat-label">Blade lifts</span><span class="stat-value">${stats.lifts}</span>
            <span class="stat-label">Output moves</span><span class="stat-value">${outputLines.length}</span>
        `;

        document.getElementById('downloadBtn').disabled = false;
        setStatus(`Processed: ${stats.cutPaths} paths, ${stats.lifts} blade lifts added`);
    } catch (err) {
        setStatus('Processing error: ' + err.message);
        console.error(err);
    } finally {
        showLoading(false);
    }
}

function doDownload() {
    if (!processedOutput) return;

    const outName = fileName.replace(/\.sbp$/i, '_knife.sbp');
    const blob = new Blob([processedOutput], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Downloaded: ${outName}`);
}

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
