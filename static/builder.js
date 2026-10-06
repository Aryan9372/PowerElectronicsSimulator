/**
 * PowerSim PRO - Interactive Power Electronics CAD & Simulator
 * Features:
 * - Real-Time Animation with moving Current Dots along wires & branches
 * - Dynamic Switch Conduction Glow (SCRs / Diodes / MOSFETs glow neon green when ON)
 * - Automatic Live Simulation upon any slider / parameter change (debounced & lag-free)
 * - Real-time playback scrubbing (Angle ωt 0-360° slider, speed 0.1x - 2x, Play/Pause)
 * - 60 FPS cached rendering loop
 */

const canvas = document.getElementById('circuitCanvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('canvas-container');

// View & Canvas State
let width = 0, height = 0;
let gridSize = 30;
let zoom = 1.0;
let panX = 40, panY = 40;

// Circuit Data
let components = [];
let groundNodes = new Set();
let probedNodes = new Set();
let compIdCounter = 1;

// Interaction State
let currentTool = 'select'; // 'select', 'probe_v', 'Wire', 'Resistor', etc.
let selectedComp = null;
let hoveredComp = null;
let hoveredNode = null;
let isMouseDown = false;
let isPanning = false;
let isDraggingComp = false;
let dragStartMouse = { x: 0, y: 0 };
let compOriginalPos = null;
let wireStartNode = null;
let currentMousePos = { x: 0, y: 0 };
let spacePressed = false;

// Cached Netlist Topology (for 60 FPS performance)
let cachedNetData = null;


// Simulation Results Cache
let lastSimResults = null;
let activeChannels = new Set();
let autoSimDebounceTimer = null;
let isSimulating = false;
let hasPendingSimulateRequest = false;
let simCyclePeriod = 0.02; // Cycle period for scrubbing / oscilloscope sync

// Dual-Mode Oscilloscope & Timescale State
let graphViewMode = 'steady'; // 'steady' or 'transient'
let simCycles = 10;
let scrubbedTimeMs = null;
let customSimTimeMs = null;
let lastCursorX = -1;
let lastCursorHeadY = -1;
let plotInteractionsSetup = false;
let isInternalPlotUpdate = false;

// Transient Viewing Window State
let transientViewDurationMs = null; // null = full timeline, number = duration clamped in ms
let transientViewStartMs = 0;
let transientViewEndMs = null;

// Initialize Canvas Sizing
function resizeCanvas() {
    if (!container) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw <= 0 || ch <= 0) return;
    if (cw === width && ch === height) return; // Prevent unnecessary buffer re-allocation and flicker
    width = cw;
    height = ch;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
}
window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 50);

// Coordinate Transforms (Screen <-> World)
function screenToWorld(sx, sy) {
    return {
        x: (sx - panX) / zoom,
        y: (sy - panY) / zoom
    };
}

function worldToScreen(wx, wy) {
    return {
        x: wx * zoom + panX,
        y: wy * zoom + panY
    };
}

function snapToGrid(worldX, worldY) {
    const gx = Math.round(worldX / gridSize) * gridSize;
    const gy = Math.round(worldY / gridSize) * gridSize;
    return { x: gx, y: gy, id: `N_${Math.round(gx/gridSize)}_${Math.round(gy/gridSize)}` };
}

function invalidateNets() {
    cachedNetData = null;
}

// -------------------------------------------------------------
// Component Data Structures
// -------------------------------------------------------------
function createComponent(type, p1, p2) {
    const id = getNextId(type);
    const comp = {
        id: id,
        type: type,
        p1: { x: p1.x, y: p1.y },
        p2: { x: p2.x, y: p2.y },
        rotation: 0,
        props: getDefaultProps(type)
    };
    invalidateNets();
    return comp;
}

function getNextId(type) {
    const prefixMap = {
        'Resistor': 'R',
        'Inductor': 'L',
        'Capacitor': 'C',
        'V_AC': 'V_ac',
        'V_DC': 'V_dc',
        'Diode': 'D',
        'Thyristor': 'T',
        'MOSFET': 'M',
        'Wire': 'W'
    };
    const prefix = prefixMap[type] || 'U';
    return `${prefix}${compIdCounter++}`;
}

function getDefaultProps(type) {
    switch (type) {
        case 'Resistor':
            return { value: 20 }; // Ohms
        case 'Inductor':
            return { value: 45 }; // mH
        case 'Capacitor':
            return { value: 220, v0: 0 }; // uF
        case 'V_AC':
            return { amplitude: 325, freq: 50, phase: 0 }; // ~230V RMS
        case 'V_DC':
            return { value: 100 }; // Volts
        case 'Diode':
            return { ron: 0.001, roff: 1e6 };
        case 'Thyristor':
            return { delay_angle: 45, width: 20, freq: 50, ron: 0.001, roff: 1e6 };
        case 'MOSFET':
            return { ctrl_type: 'pwm', freq: 5000, duty: 50, phase: 0, ron: 0.005, roff: 1e6, body_diode: true };
        default:
            return {};
    }
}

// -------------------------------------------------------------
// Netlist & Connectivity Analysis
// -------------------------------------------------------------
function computeElectricalNets() {
    if (cachedNetData) return cachedNetData;

    const parent = {};
    function find(i) {
        if (!parent[i]) parent[i] = i;
        if (parent[i] === i) return i;
        parent[i] = find(parent[i]);
        return parent[i];
    }
    function union(i, j) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent[rootI] = rootJ;
    }

    // Connect wires directly
    components.forEach(c => {
        const n1 = `N_${Math.round(c.p1.x/gridSize)}_${Math.round(c.p1.y/gridSize)}`;
        const n2 = `N_${Math.round(c.p2.x/gridSize)}_${Math.round(c.p2.y/gridSize)}`;
        find(n1); find(n2);
        if (c.type === 'Wire') {
            union(n1, n2);
        }
    });

    // Merge all ground nodes into 'GND'
    groundNodes.forEach(gId => {
        union(gId, 'GND');
    });

    const netMap = {};
    let netCounter = 1;
    const netRoots = {};

    const gndRoot = find('GND');
    netRoots[gndRoot] = 'GND';

    components.forEach(c => {
        [c.p1, c.p2].forEach(p => {
            const nodeId = `N_${Math.round(p.x/gridSize)}_${Math.round(p.y/gridSize)}`;
            const root = find(nodeId);
            if (!netRoots[root]) {
                netRoots[root] = `N${netCounter++}`;
            }
            netMap[nodeId] = netRoots[root];
        });
    });

    const pinCounts = {};
    components.forEach(c => {
        const k1 = `${c.p1.x},${c.p1.y}`;
        const k2 = `${c.p2.x},${c.p2.y}`;
        pinCounts[k1] = (pinCounts[k1] || 0) + 1;
        pinCounts[k2] = (pinCounts[k2] || 0) + 1;
    });

    cachedNetData = { netMap, pinCounts };
    return cachedNetData;
}

// -------------------------------------------------------------
// Playback & Speed Controls
// -------------------------------------------------------------
function togglePlayPause() {
    isPlaying = !isPlaying;
    const btn = document.getElementById('playPauseBtn');
    const icon = document.getElementById('playIcon');
    const label = document.getElementById('playLabel');

    if (isPlaying) {
        if (btn) btn.className = "px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1.5 shadow-md shadow-emerald-600/30 transition text-xs";
        if (icon) icon.className = "fa-solid fa-pause";
        if (label) label.innerText = "Pause";
    } else {
        if (btn) btn.className = "px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold flex items-center gap-1.5 border border-slate-700 transition text-xs";
        if (icon) icon.className = "fa-solid fa-play";
        if (label) label.innerText = "Run Real-Time";
    }
}

function setSimSpeed(speed) {
    simSpeed = Math.max(0.01, Math.min(2.0, speed));
    const slider = document.getElementById('speedSlider');
    if (slider) slider.value = simSpeed;
    const disp = document.getElementById('speedValueDisplay');
    if (disp) disp.innerText = `${simSpeed.toFixed(2)}x`;

    const allSpeedBtns = document.querySelectorAll('.speed-btn');
    allSpeedBtns.forEach(btn => {
        btn.classList.remove('bg-cyan-900', 'border-cyan-500', 'text-white', 'font-bold');
        btn.classList.add('bg-slate-800', 'border-slate-700', 'text-slate-300');
    });
    const activeBtn = document.getElementById(`speed-${speed}`);
    if (activeBtn) {
        activeBtn.classList.remove('bg-slate-800', 'border-slate-700', 'text-slate-300');
        activeBtn.classList.add('bg-cyan-900', 'border-cyan-500', 'text-white', 'font-bold');
    }
}

// -------------------------------------------------------------
// Topologies Library Modal Controls
// -------------------------------------------------------------
function openPresetsModal() {
    const modal = document.getElementById('presetsModal');
    if (modal) modal.classList.remove('hidden');
}

function closePresetsModal() {
    const modal = document.getElementById('presetsModal');
    if (modal) modal.classList.add('hidden');
}

function switchPresetTab(tabId) {
    const tabs = ['dc_dc', 'rect_1ph', 'rect_3ph', 'inverters'];
    tabs.forEach(t => {
        const tabBtn = document.getElementById(`ptab-${t}`);
        const sec = document.getElementById(`psec-${t}`);
        if (t === tabId) {
            if (tabBtn) tabBtn.className = 'preset-tab active px-3 py-2 border-b-2 border-cyan-400 font-bold text-cyan-400 flex items-center gap-1.5';
            if (sec) sec.classList.remove('hidden');
        } else {
            if (tabBtn) tabBtn.className = 'preset-tab px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-white flex items-center gap-1.5';
            if (sec) sec.classList.add('hidden');
        }
    });
}

function loadAndClosePreset(name) {
    loadPreset(name);
    closePresetsModal();
}

// Real-Time Playback & Animation State
let isPlaying = true;
let currentCycleAngleDeg = 0.0; // 0.0 to 360.0 degrees
let simSpeed = 0.5; // Playback speed (0.1x to 2x)
let lastFrameTime = performance.now();
let lastDomUpdateTime = 0;
let particlePhase = 0;
let lastActiveConductorsStr = '';

// Main Animation Loop
function animateLoop(timestamp) {
    const dt = Math.min((timestamp - lastFrameTime) / 1000.0, 0.1); // clamp dt to avoid huge jumps
    lastFrameTime = timestamp;

    if (isPlaying && scrubbedTimeMs === null) {
        // Human-visible AC cycle: 1 full 360° cycle takes 4 seconds at 1x speed (90°/sec)
        const angleSpeedDegPerSec = 90.0 * simSpeed;
        currentCycleAngleDeg = (currentCycleAngleDeg + angleSpeedDegPerSec * dt) % 360.0;
    }

    particlePhase += dt * 35.0 * simSpeed;

    // Render Canvas at 60 FPS
    renderCanvas();

    // Render Real-Time Oscilloscope Sweep Cursor at 60 FPS
    renderPlotCursor();

    // Throttle DOM text updates to 10 FPS to eliminate layout thrashing
    if (timestamp - lastDomUpdateTime > 100) {
        lastDomUpdateTime = timestamp;
        if (scrubbedTimeMs === null) {
            updateAngleDisplay(currentCycleAngleDeg);
        }
    }

    requestAnimationFrame(animateLoop);
}
requestAnimationFrame(animateLoop);

// -------------------------------------------------------------
// Real-Time Oscilloscope Sweep Line Overlay (60 FPS, Option C Cursor)
// -------------------------------------------------------------
function renderPlotCursor() {
    const cCanvas = document.getElementById('plotCursorCanvas');
    if (!cCanvas) return;
    const cctx = cCanvas.getContext('2d');
    if (!cctx) return;

    if (!lastSimResults || !lastSimResults.time || lastSimResults.time.length === 0) {
        cctx.clearRect(0, 0, cCanvas.width, cCanvas.height);
        lastCursorX = -1;
        lastCursorHeadY = -1;
        return;
    }

    const wrapper = document.getElementById('plotWrapper');
    if (!wrapper) return;
    const cw = wrapper.clientWidth;
    const ch = wrapper.clientHeight;
    if (cw <= 0 || ch <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(cw * dpr);
    const targetH = Math.round(ch * dpr);
    if (cCanvas.width !== targetW || cCanvas.height !== targetH) {
        cCanvas.width = targetW;
        cCanvas.height = targetH;
    }

    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, cCanvas.width, cCanvas.height);
    cctx.scale(dpr, dpr);

    // Margins match Plotly layout: margin: { l: 45, r: 45, t: 20, b: 35 }
    let leftMargin = 45;
    let rightMargin = 45;
    let topMargin = 20;
    let bottomMargin = 35;
    let plotW = Math.max(10, cw - leftMargin - rightMargin);
    let plotH = Math.max(10, ch - topMargin - bottomMargin);

    const plotEl = document.getElementById('plot');
    if (plotEl && plotEl._fullLayout && plotEl._fullLayout._size) {
        const sz = plotEl._fullLayout._size;
        leftMargin = sz.l;
        topMargin = sz.t;
        plotW = sz.w;
        plotH = sz.h;
    }

    const times = lastSimResults.time;
    const totalSimTime = times[times.length - 1];
    if (totalSimTime <= 0) return;
    const total_t_ms = totalSimTime * 1000.0;

    let t_start_ms, t_end_ms;
    if (lastSimResults.steady_window && typeof lastSimResults.steady_window.t_start === 'number') {
        t_start_ms = lastSimResults.steady_window.t_start * 1000.0;
        t_end_ms = lastSimResults.steady_window.t_end * 1000.0;
    } else {
        const cycleMs = (simCyclePeriod || 0.02) * 1000.0;
        t_end_ms = total_t_ms;
        t_start_ms = Math.max(0, t_end_ms - cycleMs);
    }

    let view_t0 = 0;
    let view_t1 = total_t_ms;
    if (graphViewMode === 'steady') {
        view_t0 = t_start_ms;
        view_t1 = t_end_ms;
    } else {
        view_t0 = (transientViewStartMs !== null && !isNaN(transientViewStartMs)) ? Math.max(0, transientViewStartMs) : 0;
        view_t1 = transientViewDurationMs !== null ? Math.min(total_t_ms, Math.max(view_t0 + 0.1, transientViewDurationMs)) : total_t_ms;
    }

    if (plotEl && plotEl._fullLayout && plotEl._fullLayout.xaxis && plotEl._fullLayout.xaxis.range) {
        const r = plotEl._fullLayout.xaxis.range;
        if (r && r.length === 2 && !isNaN(r[0]) && !isNaN(r[1]) && r[1] > r[0]) {
            view_t0 = r[0];
            view_t1 = r[1];
        }
    }

    const isScrubbed = (scrubbedTimeMs !== null);
    let targetTimeMs = 0;
    if (isScrubbed) {
        targetTimeMs = scrubbedTimeMs;
    } else {
        if (graphViewMode === 'steady') {
            const cycleSpanMs = Math.max(1e-4, t_end_ms - t_start_ms);
            targetTimeMs = t_start_ms + (currentCycleAngleDeg / 360.0) * cycleSpanMs;
        } else {
            const spanMs = Math.max(1e-4, view_t1 - view_t0);
            targetTimeMs = view_t0 + (currentCycleAngleDeg / 360.0) * spanMs;
        }
    }

    const fraction = (targetTimeMs - view_t0) / Math.max(1e-6, view_t1 - view_t0);
    const cursorX = leftMargin + fraction * plotW;

    // Track cursor coordinates for hit testing
    lastCursorX = cursorX;
    lastCursorHeadY = topMargin;

    if (cursorX < leftMargin - 10 || cursorX > leftMargin + plotW + 10) {
        return; // Outside visible viewport
    }

    cctx.save();

    if (isScrubbed) {
        // Option C Scrubbed Mode: Glowing Amber cursor line
        cctx.strokeStyle = '#f59e0b';
        cctx.lineWidth = 2.5;
        cctx.setLineDash([4, 2]);
        cctx.beginPath();
        cctx.moveTo(cursorX, topMargin);
        cctx.lineTo(cursorX, topMargin + plotH);
        cctx.stroke();
        cctx.setLineDash([]);

        // Glow halo
        cctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
        cctx.lineWidth = 6;
        cctx.beginPath();
        cctx.moveTo(cursorX, topMargin);
        cctx.lineTo(cursorX, topMargin + plotH);
        cctx.stroke();

        // Cursor head bead (interactive)
        cctx.fillStyle = '#b45309';
        cctx.beginPath();
        cctx.arc(cursorX, topMargin, 6, 0, Math.PI * 2);
        cctx.fill();
        cctx.fillStyle = '#fbbf24';
        cctx.beginPath();
        cctx.arc(cursorX, topMargin, 3.5, 0, Math.PI * 2);
        cctx.fill();

        // Badge: Scrub: ${scrubbedTimeMs.toFixed(2)} ms (Click to resume loop)
        const badgeText = `Scrub: ${targetTimeMs.toFixed(2)} ms (Click to resume loop)`;
        cctx.font = 'bold 9.5px monospace';
        const textW = cctx.measureText(badgeText).width;
        const badgeW = textW + 14;
        const badgeX = Math.max(leftMargin, Math.min(leftMargin + plotW - badgeW, cursorX - badgeW / 2));

        cctx.fillStyle = 'rgba(24, 18, 10, 0.95)';
        cctx.strokeStyle = '#f59e0b';
        cctx.lineWidth = 1.5;
        cctx.beginPath();
        cctx.roundRect(badgeX, topMargin + 4, badgeW, 17, 4);
        cctx.fill();
        cctx.stroke();

        cctx.fillStyle = '#fbbf24';
        cctx.fillText(badgeText, badgeX + 7, topMargin + 16);

    } else {
        // Normal Loop Mode: Neon cyan sweep cursor
        cctx.strokeStyle = '#38bdf8';
        cctx.lineWidth = 2;
        cctx.setLineDash([5, 3]);
        cctx.beginPath();
        cctx.moveTo(cursorX, topMargin);
        cctx.lineTo(cursorX, topMargin + plotH);
        cctx.stroke();
        cctx.setLineDash([]);

        // Glow halo
        cctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
        cctx.lineWidth = 5;
        cctx.beginPath();
        cctx.moveTo(cursorX, topMargin);
        cctx.lineTo(cursorX, topMargin + plotH);
        cctx.stroke();

        // Phosphor beam bead at cursor head
        cctx.fillStyle = '#0284c7';
        cctx.beginPath();
        cctx.arc(cursorX, topMargin, 5, 0, Math.PI * 2);
        cctx.fill();
        cctx.fillStyle = '#38bdf8';
        cctx.beginPath();
        cctx.arc(cursorX, topMargin, 2.5, 0, Math.PI * 2);
        cctx.fill();

        // Glowing badge showing current angle/ms
        const badgeText = `${targetTimeMs.toFixed(2)} ms (${currentCycleAngleDeg.toFixed(0)}°)`;
        cctx.font = 'bold 9px monospace';
        const textW = cctx.measureText(badgeText).width;
        const badgeW = textW + 10;
        const badgeX = Math.max(leftMargin, Math.min(leftMargin + plotW - badgeW, cursorX - badgeW / 2));

        cctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
        cctx.strokeStyle = '#0284c7';
        cctx.lineWidth = 1;
        cctx.beginPath();
        cctx.roundRect(badgeX, topMargin + 4, badgeW, 15, 3);
        cctx.fill();
        cctx.stroke();

        cctx.fillStyle = '#38bdf8';
        cctx.fillText(badgeText, badgeX + 5, topMargin + 15);
    }

    cctx.restore();
}

// -------------------------------------------------------------
// Dual-Mode Oscilloscope & Scrubbing View Controls
// -------------------------------------------------------------
function setGraphViewMode(mode) {
    if (graphViewMode === mode) return;
    graphViewMode = mode;
    updateViewModeButtons();
    updatePlot();
    if (lastSimResults) {
        updateStatsDashboard(lastSimResults);
    }
}

function updateViewModeButtons() {
    const btnSteady = document.getElementById('btnViewSteady');
    const btnTransient = document.getElementById('btnViewTransient');
    if (btnSteady && btnTransient) {
        if (graphViewMode === 'steady') {
            btnSteady.className = 'px-2 py-0.5 rounded text-[11px] font-semibold bg-cyan-600/30 text-cyan-300 border border-cyan-500/50 shadow-sm shadow-cyan-500/20 transition flex items-center gap-1';
            btnTransient.className = 'px-2 py-0.5 rounded text-[11px] text-slate-400 hover:text-slate-200 border border-transparent transition flex items-center gap-1';
        } else {
            btnSteady.className = 'px-2 py-0.5 rounded text-[11px] text-slate-400 hover:text-slate-200 border border-transparent transition flex items-center gap-1';
            btnTransient.className = 'px-2 py-0.5 rounded text-[11px] font-semibold bg-cyan-600/30 text-cyan-300 border border-cyan-500/50 shadow-sm shadow-cyan-500/20 transition flex items-center gap-1';
        }
    }

    const durationBar = document.getElementById('transientDurationBar');
    if (durationBar) {
        if (graphViewMode === 'transient') {
            durationBar.classList.remove('hidden');
            durationBar.classList.add('flex');
            syncTransientControlsUI();
        } else {
            durationBar.classList.add('hidden');
            durationBar.classList.remove('flex');
        }
    }
}

// -------------------------------------------------------------
// Transient Viewing Duration Controls
// -------------------------------------------------------------
function setTransientViewDuration(val) {
    if (val === 'all' || val === 'All' || val === null || val === undefined || val === '') {
        transientViewDurationMs = null;
        transientViewStartMs = 0;
        transientViewEndMs = null;
    } else {
        const num = parseFloat(val);
        if (!isNaN(num) && num > 0) {
            transientViewDurationMs = num;
            transientViewStartMs = 0;
            transientViewEndMs = num;
        } else {
            return;
        }
    }

    // Sync input, slider, and quick preset buttons
    syncTransientControlsUI();

    // Check if requested duration exceeds total solved simulation duration
    let totalSimTimeMs = 0;
    if (lastSimResults && lastSimResults.time && lastSimResults.time.length > 0) {
        totalSimTimeMs = lastSimResults.time[lastSimResults.time.length - 1] * 1000.0;
    } else if (customSimTimeMs !== null) {
        totalSimTimeMs = customSimTimeMs;
    } else {
        totalSimTimeMs = simCycles * (simCyclePeriod || 0.02) * 1000.0;
    }

    if (transientViewDurationMs !== null && transientViewDurationMs > totalSimTimeMs) {
        customSimTimeMs = transientViewDurationMs;
        const customOpt = document.getElementById('optCustomCycles');
        if (customOpt) customOpt.text = `Custom (${transientViewDurationMs.toFixed(0)} ms)`;
        const simCyclesSelect = document.getElementById('simCyclesSelect');
        if (simCyclesSelect) simCyclesSelect.value = 'custom';

        clearTimeout(autoSimDebounceTimer);
        autoSimDebounceTimer = setTimeout(() => {
            runSimulation(true);
        }, 150);
        return;
    }

    updatePlot();
    if (lastSimResults) {
        updateStatsDashboard(lastSimResults);
    }
}

function onTransientDurationInput(val) {
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0) {
        const sld = document.getElementById('transientDurationSlider');
        if (sld && document.activeElement !== sld) {
            sld.value = num;
        }
        setTransientViewDuration(num);
    } else if (val === '' || val === 'all' || val === 'All') {
        setTransientViewDuration('all');
    }
}

function onTransientDurationSlider(val) {
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0) {
        const inp = document.getElementById('transientDurationInput');
        if (inp && document.activeElement !== inp) {
            inp.value = num;
        }
        setTransientViewDuration(num);
    }
}

function syncTransientControlsUI() {
    let totalSimTimeMs = 200;
    if (lastSimResults && lastSimResults.time && lastSimResults.time.length > 0) {
        totalSimTimeMs = lastSimResults.time[lastSimResults.time.length - 1] * 1000.0;
    }

    const inp = document.getElementById('transientDurationInput');
    const sld = document.getElementById('transientDurationSlider');

    const displayVal = transientViewDurationMs !== null ? Math.round(transientViewDurationMs) : Math.round(totalSimTimeMs);

    if (inp && document.activeElement !== inp) {
        inp.value = transientViewDurationMs !== null ? transientViewDurationMs : '';
        inp.placeholder = Math.round(totalSimTimeMs);
    }

    if (sld && document.activeElement !== sld) {
        if (sld.max && Number(sld.max) < displayVal) {
            sld.max = Math.max(1000, Math.ceil(displayVal * 1.5 / 50) * 50);
        }
        sld.value = displayVal;
    }

    const readout = document.getElementById('transientDurationReadout');
    if (readout) {
        if (transientViewDurationMs === null) {
            readout.innerText = `All (${Math.round(totalSimTimeMs)} ms)`;
        } else {
            readout.innerText = `${Math.round(transientViewDurationMs)} ms`;
        }
    }

    updateTransientPresetButtonsUI();
}

function updateTransientPresetButtonsUI() {
    const presetMap = {
        'tbtn-20': 20,
        'tbtn-50': 50,
        'tbtn-100': 100,
        'tbtn-200': 200,
        'tbtn-all': null,
        'btnTransient20': 20,
        'btnTransient50': 50,
        'btnTransient100': 100,
        'btnTransient200': 200,
        'btnTransientAll': null
    };

    const presetButtons = document.querySelectorAll('.transient-preset-btn, [data-duration]');
    if (presetButtons && presetButtons.length > 0) {
        presetButtons.forEach(btn => {
            const durAttr = btn.getAttribute('data-duration');
            let isCurrent = false;
            if (durAttr) {
                if (durAttr === 'all' || durAttr === 'All') {
                    isCurrent = (transientViewDurationMs === null);
                } else {
                    const durNum = parseFloat(durAttr);
                    isCurrent = (transientViewDurationMs !== null && Math.abs(transientViewDurationMs - durNum) < 1e-3);
                }
            } else if (btn.id && presetMap[btn.id] !== undefined) {
                const targetVal = presetMap[btn.id];
                isCurrent = (targetVal === null) ? (transientViewDurationMs === null) : (transientViewDurationMs !== null && Math.abs(transientViewDurationMs - targetVal) < 1e-3);
            } else {
                const txt = btn.innerText.trim();
                if (txt.includes('All') || txt.includes('Full')) {
                    isCurrent = (transientViewDurationMs === null);
                } else {
                    const parsed = parseFloat(txt);
                    isCurrent = (!isNaN(parsed) && transientViewDurationMs !== null && Math.abs(transientViewDurationMs - parsed) < 1e-3);
                }
            }

            if (isCurrent) {
                btn.classList.add('active');
                btn.classList.add('bg-cyan-600/30', 'text-cyan-300', 'border-cyan-500/50', 'shadow-sm', 'shadow-cyan-500/20');
                btn.classList.remove('text-slate-400', 'border-transparent', 'hover:text-slate-200');
            } else {
                btn.classList.remove('active');
                btn.classList.remove('bg-cyan-600/30', 'text-cyan-300', 'border-cyan-500/50', 'shadow-sm', 'shadow-cyan-500/20');
                btn.classList.add('text-slate-400', 'border-transparent', 'hover:text-slate-200');
            }
        });
    }
}

function handlePlotlyRelayout(eventData) {
    if (graphViewMode !== 'transient') return;
    if (!lastSimResults || !lastSimResults.time || lastSimResults.time.length === 0) return;

    const totalSimTimeMs = lastSimResults.time[lastSimResults.time.length - 1] * 1000.0;
    let newStart = null;
    let newEnd = null;

    if (eventData['xaxis.range[0]'] !== undefined && eventData['xaxis.range[1]'] !== undefined) {
        newStart = Number(eventData['xaxis.range[0]']);
        newEnd = Number(eventData['xaxis.range[1]']);
    } else if (Array.isArray(eventData['xaxis.range'])) {
        newStart = Number(eventData['xaxis.range'][0]);
        newEnd = Number(eventData['xaxis.range'][1]);
    } else if (eventData['xaxis.autorange'] === true) {
        newStart = 0;
        newEnd = totalSimTimeMs;
        transientViewDurationMs = null;
    }

    if (newStart !== null && newEnd !== null && !isNaN(newStart) && !isNaN(newEnd) && newEnd > newStart) {
        transientViewStartMs = Math.max(0, newStart);
        transientViewEndMs = Math.min(totalSimTimeMs, newEnd);
        if (eventData['xaxis.autorange'] !== true) {
            transientViewDurationMs = Math.max(0.1, transientViewEndMs - transientViewStartMs);
        }
        syncTransientControlsUI();
        if (lastSimResults) {
            updateStatsDashboard(lastSimResults);
        }
    }
}

window.setTransientViewDuration = setTransientViewDuration;
window.onTransientDurationInput = onTransientDurationInput;
window.onTransientDurationSlider = onTransientDurationSlider;
window.syncTransientControlsUI = syncTransientControlsUI;

function exportTransientDataCSV() {
    if (!lastSimResults || !lastSimResults.time || lastSimResults.time.length === 0) {
        alert('No simulation data available to export. Run a simulation first.');
        return;
    }

    const times = lastSimResults.time;
    const totalSimTimeMs = times[times.length - 1] * 1000.0;
    const v0Ms = (transientViewStartMs !== null && !isNaN(transientViewStartMs)) ? Math.max(0, transientViewStartMs) : 0;
    const v1Ms = (transientViewEndMs !== null && !isNaN(transientViewEndMs)) ? Math.min(totalSimTimeMs, transientViewEndMs) : (transientViewDurationMs !== null ? Math.min(totalSimTimeMs, transientViewDurationMs) : totalSimTimeMs);

    const v0Sec = v0Ms / 1000.0;
    const v1Sec = v1Ms / 1000.0;

    const indices = [];
    for (let i = 0; i < times.length; i++) {
        if (times[i] >= v0Sec - 1e-9 && times[i] <= v1Sec + 1e-9) {
            indices.push(i);
        }
    }

    if (indices.length === 0) {
        alert('No data points found within the selected viewing duration.');
        return;
    }

    const nodeKeys = lastSimResults.nodes ? Object.keys(lastSimResults.nodes) : [];
    const branchKeys = lastSimResults.branch_i ? Object.keys(lastSimResults.branch_i) : [];

    let csv = 'Time_s,Time_ms';
    nodeKeys.forEach(k => { csv += `,V(${k})_V`; });
    branchKeys.forEach(k => { csv += `,I(${k})_A`; });
    csv += '\n';

    indices.forEach(idx => {
        const tSec = times[idx];
        const tMs = (tSec * 1000.0).toFixed(4);
        let row = `${tSec.toFixed(7)},${tMs}`;

        nodeKeys.forEach(k => {
            const arr = lastSimResults.nodes[k];
            row += `,${arr && arr.length > idx ? arr[idx].toFixed(4) : ''}`;
        });
        branchKeys.forEach(k => {
            const arr = lastSimResults.branch_i[k];
            row += `,${arr && arr.length > idx ? arr[idx].toFixed(4) : ''}`;
        });
        csv += row + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `powersim_transient_${Math.round(v0Ms)}ms_to_${Math.round(v1Ms)}ms.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

window.exportTransientDataCSV = exportTransientDataCSV;

function onPlotScrub(timeMs) {
    if (!lastSimResults) return;
    scrubbedTimeMs = Math.max(0, timeMs);

    const btnResume = document.getElementById('btnResumeSweep');
    if (btnResume) btnResume.classList.remove('hidden');

    const ribbonScrub = document.getElementById('ribbonScrubIndicator');
    if (ribbonScrub) {
        ribbonScrub.classList.remove('hidden');
        ribbonScrub.classList.add('flex');
        const ribbonText = document.getElementById('ribbonScrubText');
        if (ribbonText) ribbonText.innerText = `Scrub: ${scrubbedTimeMs.toFixed(1)} ms`;
    }

    // Sync angle display and slider to corresponding cycle angle
    const times = lastSimResults.time;
    const totalSimTime = times[times.length - 1];
    let t_start = 0, t_end = totalSimTime;
    if (lastSimResults.steady_window && typeof lastSimResults.steady_window.t_start === 'number') {
        t_start = lastSimResults.steady_window.t_start;
        t_end = lastSimResults.steady_window.t_end;
    } else {
        t_start = Math.max(0, totalSimTime - simCyclePeriod);
        t_end = totalSimTime;
    }
    const cyclePeriod = Math.max(1e-6, t_end - t_start);
    const scrubSec = scrubbedTimeMs / 1000.0;
    const relSec = ((scrubSec - t_start) % cyclePeriod + cyclePeriod) % cyclePeriod;
    currentCycleAngleDeg = (relSec / cyclePeriod) * 360.0;
    updateAngleDisplay(currentCycleAngleDeg);

    // Update schematic animation instantly
    renderCanvas();
    renderPlotCursor();
}

function resumeSweep() {
    scrubbedTimeMs = null;
    const btnResume = document.getElementById('btnResumeSweep');
    if (btnResume) btnResume.classList.add('hidden');

    const ribbonScrub = document.getElementById('ribbonScrubIndicator');
    if (ribbonScrub) {
        ribbonScrub.classList.add('hidden');
        ribbonScrub.classList.remove('flex');
    }

    renderCanvas();
    renderPlotCursor();
}

function onSimCyclesChange(val) {
    if (val === 'custom') {
        const currentMs = (customSimTimeMs || (simCycles * (simCyclePeriod || 0.02) * 1000)).toFixed(0);
        const promptVal = prompt('Enter custom simulation duration in milliseconds (ms):', currentMs);
        const parsed = parseFloat(promptVal);
        if (!isNaN(parsed) && parsed > 0) {
            customSimTimeMs = parsed;
            simCycles = Math.max(1, Math.round(parsed / ((simCyclePeriod || 0.02) * 1000)));
            const customOpt = document.getElementById('optCustomCycles');
            if (customOpt) customOpt.text = `Custom (${parsed.toFixed(0)} ms)`;
        } else {
            document.getElementById('simCyclesSelect').value = String(simCycles);
            return;
        }
    } else {
        customSimTimeMs = null;
        simCycles = parseInt(val, 10) || 10;
        const customOpt = document.getElementById('optCustomCycles');
        if (customOpt) customOpt.text = 'Custom ms (prompt/input)';
    }
    runSimulation(true);
}

// -------------------------------------------------------------
// Expand / Restore Oscilloscope Window
// -------------------------------------------------------------
let isGraphExpanded = false;
function toggleExpandGraph() {
    isGraphExpanded = !isGraphExpanded;
    const panel = document.getElementById('rightPanel');
    const label = document.getElementById('expandGraphLabel');
    const icon = document.getElementById('expandGraphIcon');
    if (!panel) return;

    if (isGraphExpanded) {
        panel.classList.remove('w-[480px]', 'lg:w-[520px]');
        panel.classList.add('w-[720px]', 'lg:w-[780px]');
        if (label) label.innerText = 'Restore';
        if (icon) icon.className = 'fa-solid fa-down-left-and-up-right-to-center text-[10px] text-amber-400';
    } else {
        panel.classList.remove('w-[720px]', 'lg:w-[780px]');
        panel.classList.add('w-[480px]', 'lg:w-[520px]');
        if (label) label.innerText = 'Expand';
        if (icon) icon.className = 'fa-solid fa-up-right-and-down-left-from-center text-[10px] text-cyan-400';
    }

    setTimeout(() => {
        if (window.Plotly) Plotly.Plots.resize('plot');
    }, 310);
}

function onAngleSliderInput(angleDeg) {
    if (scrubbedTimeMs !== null) {
        resumeSweep();
    }
    currentCycleAngleDeg = Math.max(0, Math.min(360, angleDeg));
    updateAngleDisplay(currentCycleAngleDeg);
}

function stepAnimation(direction) {
    if (scrubbedTimeMs !== null) {
        resumeSweep();
    }
    currentCycleAngleDeg = (currentCycleAngleDeg + direction * 5.0 + 360.0) % 360.0;
    updateAngleDisplay(currentCycleAngleDeg);
}

function resetAnimation() {
    if (scrubbedTimeMs !== null) {
        resumeSweep();
    }
    currentCycleAngleDeg = 0.0;
    updateAngleDisplay(0.0);
}

function updateAngleDisplay(deg) {
    const slider = document.getElementById('angleSlider');
    const disp = document.getElementById('angleValueDisplay');
    if (slider && document.activeElement !== slider) slider.value = Math.round(deg);
    if (disp) disp.innerText = `${deg.toFixed(1)}°`;
}

// Canvas Rendering Logic
function renderCanvas() {
    if (!ctx || width <= 0 || height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    // Perfect clean redraw with no ghosting or flicker
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    // 1. Grid
    drawGrid();

    const { netMap, pinCounts } = computeElectricalNets();

    // 2. Ground Symbols
    groundNodes.forEach(gid => {
        const parts = gid.split('_');
        const gx = parseInt(parts[1]) * gridSize;
        const gy = parseInt(parts[2]) * gridSize;
        drawGroundSymbol(gx, gy);
    });

    // 3. Components & Wires
    const stepIdx = getSimulationStepIndex();
    const activeConductors = [];

    components.forEach(c => {
        const isSelected = (c === selectedComp);
        const isHovered = (c === hoveredComp);
        const state = getComponentSwitchState(c, stepIdx);
        const currentVal = getComponentCurrent(c, stepIdx);

        if (state === true || state === 1) {
            activeConductors.push(c.id);
        }

        drawComponent(c, isSelected, isHovered, netMap, state, currentVal);
    });

    // 4. Animated Current Flow Dots (along wires and components)
    const showCurrentFlow = document.getElementById('showCurrentFlowToggle')?.checked ?? true;
    if (showCurrentFlow && lastSimResults) {
        drawCurrentFlowParticles(stepIdx);
    }

    // 5. Junction Dots
    for (const [key, count] of Object.entries(pinCounts)) {
        if (count >= 3) {
            const [x, y] = key.split(',').map(Number);
            ctx.fillStyle = '#06b6d4';
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // 6. Net Labels / Badges
    const showNets = document.getElementById('showNetsToggle')?.checked ?? true;
    if (showNets) {
        drawNetBadges(netMap);
    }

    // 7. Interactive Voltage Probes
    drawProbes(netMap);

    // 8. Active Interaction Previews
    if (currentTool === 'Wire' && isMouseDown && wireStartNode) {
        const p1 = wireStartNode;
        const p2 = snapToGrid(currentMousePos.x, currentMousePos.y);
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]);
        drawSnapHalo(p2.x, p2.y);
    } else if (currentTool !== 'select' && currentTool !== 'probe_v' && currentTool !== 'Ground' && isMouseDown && wireStartNode) {
        const p1 = wireStartNode;
        const p2 = snapToGrid(currentMousePos.x, currentMousePos.y);
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
    }

    if (hoveredNode) {
        drawSnapHalo(hoveredNode.x, hoveredNode.y);
    }

    // Update Conduction Badge Status in HUD only when changed
    const conductorsStr = activeConductors.sort().join(' + ');
    if (conductorsStr !== lastActiveConductorsStr) {
        lastActiveConductorsStr = conductorsStr;
        updateConductionStatusText(activeConductors);
    }

    ctx.restore();
}


function getSimulationStepIndex() {
    if (!lastSimResults || !lastSimResults.time || lastSimResults.time.length === 0) return 0;
    const times = lastSimResults.time;
    const totalSimTime = times[times.length - 1];
    if (totalSimTime <= 0) return 0;

    let targetTimeSec = 0;
    if (scrubbedTimeMs !== null) {
        targetTimeSec = scrubbedTimeMs / 1000.0;
    } else {
        let t_start = 0;
        let t_end = totalSimTime;
        if (graphViewMode === 'steady') {
            if (lastSimResults.steady_window && typeof lastSimResults.steady_window.t_start === 'number') {
                t_start = lastSimResults.steady_window.t_start;
                t_end = lastSimResults.steady_window.t_end;
            } else {
                t_start = Math.max(0, totalSimTime - simCyclePeriod);
                t_end = totalSimTime;
            }
        } else {
            const v0 = (transientViewStartMs !== null && !isNaN(transientViewStartMs)) ? Math.max(0, transientViewStartMs) : 0;
            const v1 = transientViewDurationMs !== null ? Math.min(totalSimTime * 1000.0, Math.max(v0 + 0.1, transientViewDurationMs)) : (totalSimTime * 1000.0);
            t_start = v0 / 1000.0;
            t_end = v1 / 1000.0;
        }
        const cyclePeriod = Math.max(1e-6, t_end - t_start);
        targetTimeSec = t_start + (currentCycleAngleDeg / 360.0) * cyclePeriod;
    }

    targetTimeSec = Math.max(times[0], Math.min(times[times.length - 1], targetTimeSec));

    // Fast binary search for closest time in array
    let low = 0, high = times.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (times[mid] < targetTimeSec) {
            low = mid + 1;
        } else if (times[mid] > targetTimeSec) {
            high = mid - 1;
        } else {
            return mid;
        }
    }
    if (high < 0) return 0;
    if (low >= times.length) return times.length - 1;
    return (Math.abs(times[low] - targetTimeSec) < Math.abs(times[high] - targetTimeSec)) ? low : high;
}

function getComponentSwitchState(comp, stepIdx) {
    if (!lastSimResults || !lastSimResults.switches) return false;
    const swArr = lastSimResults.switches[comp.id];
    if (swArr && swArr.length > stepIdx) {
        return swArr[stepIdx] > 0.5;
    }
    return false;
}

function getComponentCurrent(comp, stepIdx) {
    if (!lastSimResults || !lastSimResults.branch_i) return 0;
    const iArr = lastSimResults.branch_i[comp.id];
    if (iArr && iArr.length > stepIdx) {
        return iArr[stepIdx];
    }
    return 0;
}

function updateConductionStatusText(activeConductors) {
    const textEl = document.getElementById('conductionStatusText');
    const badgeEl = document.getElementById('conductionStatusBadge');
    if (!textEl || !badgeEl) return;

    if (activeConductors.length > 0) {
        textEl.innerText = `Active Switches: ${activeConductors.join(' + ')} (ON)`;
        badgeEl.className = "px-2.5 py-1 rounded bg-emerald-950/80 border border-emerald-500 text-[11px] font-mono text-emerald-300 flex items-center gap-1.5 shadow-md shadow-emerald-500/20";
    } else {
        textEl.innerText = "All Switches OFF";
        badgeEl.className = "px-2.5 py-1 rounded bg-slate-800/80 border border-slate-700 text-[11px] font-mono text-slate-400 flex items-center gap-1.5";
    }
}

// -------------------------------------------------------------
// Animated Current Flow Particles
// -------------------------------------------------------------
function drawCurrentFlowParticles(stepIdx) {
    ctx.save();
    ctx.fillStyle = '#38bdf8';

    components.forEach(c => {
        const iVal = getComponentCurrent(c, stepIdx);
        if (Math.abs(iVal) < 0.005) return; // Negligible current

        const x1 = c.p1.x, y1 = c.p1.y;
        const x2 = c.p2.x, y2 = c.p2.y;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 5) return;

        const dir = (iVal >= 0) ? 1 : -1;
        const spacing = 18; // Dot spacing in pixels
        const speedMultiplier = Math.min(2.5, Math.max(0.5, Math.log10(1 + Math.abs(iVal) * 5)));
        const offset = ((particlePhase * speedMultiplier * dir) % spacing + spacing) % spacing;

        const ux = dx / len;
        const uy = dy / len;

        for (let d = offset; d < len; d += spacing) {
            const px = x1 + ux * d;
            const py = y1 + uy * d;
            ctx.beginPath();
            ctx.arc(px, py, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    });

    ctx.restore();
}

function drawGrid() {
    const startX = Math.floor(-panX / zoom / gridSize) * gridSize - gridSize;
    const endX = Math.ceil((width - panX) / zoom / gridSize) * gridSize + gridSize;
    const startY = Math.floor(-panY / zoom / gridSize) * gridSize - gridSize;
    const endY = Math.ceil((height - panY) / zoom / gridSize) * gridSize + gridSize;

    ctx.fillStyle = 'rgba(71, 85, 105, 0.25)';
    for (let x = startX; x <= endX; x += gridSize) {
        for (let y = startY; y <= endY; y += gridSize) {
            ctx.fillRect(x - 1, y - 1, 2, 2);
        }
    }
}

function drawSnapHalo(x, y) {
    ctx.save();
    ctx.strokeStyle = '#10b981';
    ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

function drawGroundSymbol(x, y) {
    ctx.save();
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x, y + 16);
    ctx.moveTo(x - 12, y + 16); ctx.lineTo(x + 12, y + 16);
    ctx.moveTo(x - 8, y + 21); ctx.lineTo(x + 8, y + 21);
    ctx.moveTo(x - 4, y + 26); ctx.lineTo(x + 4, y + 26);
    ctx.stroke();

    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 9px sans-serif';
    ctx.fillText('0V GND', x + 10, y + 25);
    ctx.restore();
}

function drawNetBadges(netMap) {
    const drawn = new Set();
    components.forEach(c => {
        [c.p1, c.p2].forEach(p => {
            const key = `${p.x},${p.y}`;
            const nodeId = `N_${Math.round(p.x/gridSize)}_${Math.round(p.y/gridSize)}`;
            const netName = netMap[nodeId] || nodeId;
            if (drawn.has(key)) return;
            drawn.add(key);

            ctx.save();
            ctx.font = '10px monospace';
            const text = netName;
            const tw = ctx.measureText(text).width;
            const bx = p.x + 6;
            const by = p.y - 14;

            ctx.fillStyle = (netName === 'GND') ? 'rgba(16, 185, 129, 0.85)' : 'rgba(15, 23, 42, 0.85)';
            ctx.strokeStyle = (netName === 'GND') ? '#10b981' : '#334155';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(bx, by, tw + 8, 14, 3);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = (netName === 'GND') ? '#ffffff' : '#38bdf8';
            ctx.fillText(text, bx + 4, by + 10);
            ctx.restore();
        });
    });
}

function drawProbes(netMap) {
    probedNodes.forEach(nodeId => {
        const parts = nodeId.split('_');
        if (parts.length < 3) return;
        const x = parseInt(parts[1]) * gridSize;
        const y = parseInt(parts[2]) * gridSize;
        const netName = netMap[nodeId] || nodeId;

        ctx.save();
        ctx.fillStyle = '#f59e0b';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x + 14, y - 18);
        ctx.lineTo(x + 38, y - 18);
        ctx.lineTo(x + 38, y - 6);
        ctx.lineTo(x, y - 6);
        ctx.fill();

        ctx.fillStyle = '#000000';
        ctx.font = 'bold 9px sans-serif';
        ctx.fillText(`V(${netName})`, x + 6, y - 9);
        ctx.restore();
    });
}

function drawComponent(c, isSelected, isHovered, netMap, isSwitchActive, currentVal) {
    const x1 = c.p1.x, y1 = c.p1.y;
    const x2 = c.p2.x, y2 = c.p2.y;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const angle = Math.atan2(dy, dx);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;

    ctx.save();

    // Active Conduction Glow for Switches (SCR / Diode / MOSFET)
    const isSwitchType = (c.type === 'Thyristor' || c.type === 'Diode' || c.type === 'MOSFET');
    if (isSwitchType) {
        if (isSwitchActive) {
            // Neon Green Glow Box around switch (clean, flicker-free rendering)
            ctx.save();
            ctx.fillStyle = 'rgba(34, 197, 94, 0.22)';
            ctx.strokeStyle = '#22c55e';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.roundRect(mx - 24, my - 24, 48, 48, 8);
            ctx.fill();
            ctx.stroke();

            // Soft outer halo border
            ctx.strokeStyle = 'rgba(34, 197, 94, 0.35)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(mx - 27, my - 27, 54, 54, 10);
            ctx.stroke();
            ctx.restore();
        } else {
            // Inactive subtle border
            ctx.strokeStyle = 'rgba(51, 65, 85, 0.6)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(mx - 22, my - 22, 44, 44, 6);
            ctx.stroke();
        }
    }

    // Selection Glow Box
    if (isSelected) {
        ctx.strokeStyle = '#eab308';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        const pad = 12;
        ctx.strokeRect(Math.min(x1, x2) - pad, Math.min(y1, y2) - pad, Math.abs(dx) + pad * 2, Math.abs(dy) + pad * 2);
        ctx.setLineDash([]);
    } else if (isHovered) {
        ctx.strokeStyle = 'rgba(234, 179, 8, 0.4)';
        ctx.lineWidth = 1;
        const pad = 10;
        ctx.strokeRect(Math.min(x1, x2) - pad, Math.min(y1, y2) - pad, Math.abs(dx) + pad * 2, Math.abs(dy) + pad * 2);
    }

    // Terminal Pin Dots
    [c.p1, c.p2].forEach(p => {
        ctx.fillStyle = '#06b6d4';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
    });

    let mainColor = isSelected ? '#facc15' : (isHovered ? '#38bdf8' : '#e2e8f0');
    if (isSwitchType && isSwitchActive) {
        mainColor = '#22c55e'; // Green when conducting
    }

    ctx.strokeStyle = mainColor;
    ctx.fillStyle = mainColor;
    ctx.lineWidth = 2.5;

    if (c.type === 'Wire') {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
        return;
    }

    const bodyHalf = 24;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(mx - Math.cos(angle) * bodyHalf, my - Math.sin(angle) * bodyHalf);
    ctx.moveTo(mx + Math.cos(angle) * bodyHalf, my + Math.sin(angle) * bodyHalf);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.translate(mx, my);
    ctx.rotate(angle);

    // Symbols
    switch (c.type) {
        case 'Resistor':
            ctx.strokeRect(-18, -7, 36, 14);
            break;

        case 'Inductor':
            ctx.beginPath();
            ctx.arc(-12, 0, 6, Math.PI, 0);
            ctx.arc(0, 0, 6, Math.PI, 0);
            ctx.arc(12, 0, 6, Math.PI, 0);
            ctx.stroke();
            break;

        case 'Capacitor':
            ctx.beginPath();
            ctx.moveTo(-6, -15); ctx.lineTo(-6, 15);
            ctx.moveTo(6, -15); ctx.lineTo(6, 15);
            ctx.stroke();
            break;

        case 'V_AC':
            ctx.beginPath();
            ctx.arc(0, 0, 16, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-8, 0);
            ctx.bezierCurveTo(-4, -8, -4, -8, 0, 0);
            ctx.bezierCurveTo(4, 8, 4, 8, 8, 0);
            ctx.stroke();
            break;

        case 'V_DC':
            ctx.beginPath();
            ctx.moveTo(-6, -16); ctx.lineTo(-6, 16);
            ctx.moveTo(6, -9); ctx.lineTo(6, 9);
            ctx.stroke();
            ctx.font = '10px sans-serif';
            ctx.fillText('+', -14, -10);
            break;

        case 'Diode':
            ctx.beginPath();
            ctx.moveTo(-12, -12); ctx.lineTo(10, 0); ctx.lineTo(-12, 12); ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(10, -14); ctx.lineTo(10, 14);
            ctx.stroke();
            break;

        case 'Thyristor':
            ctx.beginPath();
            ctx.moveTo(-12, -12); ctx.lineTo(10, 0); ctx.lineTo(-12, 12); ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(10, -14); ctx.lineTo(10, 14);
            ctx.stroke();
            // Gate
            ctx.beginPath();
            ctx.moveTo(4, 6); ctx.lineTo(12, 18); ctx.lineTo(20, 18);
            ctx.stroke();
            ctx.fillText('G', 16, 14);
            break;

        case 'MOSFET':
            ctx.beginPath();
            ctx.moveTo(-18, -12); ctx.lineTo(-4, -12);
            ctx.moveTo(18, 12); ctx.lineTo(-4, 12);
            ctx.moveTo(-4, -14); ctx.lineTo(-4, -8);
            ctx.moveTo(-4, -3); ctx.lineTo(-4, 3);
            ctx.moveTo(-4, 8); ctx.lineTo(-4, 14);
            ctx.moveTo(-9, -15); ctx.lineTo(-9, 15);
            ctx.moveTo(-9, 0); ctx.lineTo(-20, 0);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(2, 3); ctx.lineTo(-4, 0); ctx.lineTo(2, -3);
            ctx.fillStyle = mainColor;
            ctx.fill();
            ctx.fillText('G', -24, -4);
            break;
    }

    ctx.restore();

    // Labels & Status Badges
    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = isSelected ? '#facc15' : '#e2e8f0';
    const label = `${c.id} (${getPropSummary(c)})`;
    ctx.fillText(label, mx - 14, my - 28);

    if (isSwitchType) {
        ctx.font = 'bold 10px monospace';
        if (isSwitchActive) {
            ctx.fillStyle = '#22c55e';
            ctx.fillText('ON', mx - 8, my + 34);
        } else {
            ctx.fillStyle = '#64748b';
            ctx.fillText('OFF', mx - 10, my + 34);
        }
    }
    ctx.restore();
}

function getPropSummary(c) {
    if (c.type === 'Resistor') return `${c.props.value}Ω`;
    if (c.type === 'Inductor') return `${c.props.value}mH`;
    if (c.type === 'Capacitor') return `${c.props.value}µF`;
    if (c.type === 'V_AC') return `${c.props.amplitude}V`;
    if (c.type === 'V_DC') return `${c.props.value}V`;
    if (c.type === 'Thyristor') return `α=${c.props.delay_angle}°`;
    if (c.type === 'MOSFET') return `D=${c.props.duty}%`;
    return '';
}

// -------------------------------------------------------------
// Mouse & Touch Interactions
// -------------------------------------------------------------
canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const snapped = snapToGrid(world.x, world.y);

    dragStartMouse = { x: sx, y: sy };
    isMouseDown = true;

    if (spacePressed || e.button === 1) {
        isPanning = true;
        return;
    }

    if (currentTool === 'probe_v') {
        const targetNode = findNearestNode(world.x, world.y);
        if (targetNode) {
            if (probedNodes.has(targetNode.id)) {
                probedNodes.delete(targetNode.id);
            } else {
                probedNodes.add(targetNode.id);
            }
            updatePlot();
        }
        return;
    }

    if (currentTool === 'Ground') {
        const targetNode = snapped;
        if (groundNodes.has(targetNode.id)) {
            groundNodes.delete(targetNode.id);
        } else {
            groundNodes.add(targetNode.id);
        }
        invalidateNets();
        triggerAutoSimulate();
        return;
    }

    if (currentTool === 'select') {
        const clicked = findComponentAt(world.x, world.y);
        if (clicked) {
            selectedComp = clicked;
            isDraggingComp = true;
            compOriginalPos = {
                p1: { ...clicked.p1 },
                p2: { ...clicked.p2 }
            };
            updatePropsInspector();
        } else {
            selectedComp = null;
            updatePropsInspector();
        }
        return;
    }

    wireStartNode = snapped;
});

canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    currentMousePos = screenToWorld(sx, sy);

    if (isPanning) {
        panX += (sx - dragStartMouse.x);
        panY += (sy - dragStartMouse.y);
        dragStartMouse = { x: sx, y: sy };
        return;
    }

    if (isDraggingComp && selectedComp && compOriginalPos) {
        const totalDeltaX = (currentMousePos.x - screenToWorld(dragStartMouse.x, dragStartMouse.y).x);
        const totalDeltaY = (currentMousePos.y - screenToWorld(dragStartMouse.y, dragStartMouse.y).y);
        const snappedDeltaX = Math.round(totalDeltaX / gridSize) * gridSize;
        const snappedDeltaY = Math.round(totalDeltaY / gridSize) * gridSize;

        selectedComp.p1.x = compOriginalPos.p1.x + snappedDeltaX;
        selectedComp.p1.y = compOriginalPos.p1.y + snappedDeltaY;
        selectedComp.p2.x = compOriginalPos.p2.x + snappedDeltaX;
        selectedComp.p2.y = compOriginalPos.p2.y + snappedDeltaY;
        invalidateNets();
        return;
    }

    hoveredComp = findComponentAt(currentMousePos.x, currentMousePos.y);
    hoveredNode = findNearestNode(currentMousePos.x, currentMousePos.y, 16);
});

window.addEventListener('mouseup', (e) => {
    if (!isMouseDown) return;
    isMouseDown = false;
    isPanning = false;

    if (isDraggingComp) {
        isDraggingComp = false;
        compOriginalPos = null;
        triggerAutoSimulate();
        return;
    }

    if (wireStartNode) {
        const snappedEnd = snapToGrid(currentMousePos.x, currentMousePos.y);
        if (wireStartNode.x !== snappedEnd.x || wireStartNode.y !== snappedEnd.y) {
            const comp = createComponent(currentTool, wireStartNode, snappedEnd);
            components.push(comp);
            selectedComp = comp;
            invalidateNets();
            selectTool('select');
            triggerAutoSimulate();
        }
        wireStartNode = null;
    }
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    panX = mx - (mx - panX) * zoomFactor;
    panY = my - (my - panY) * zoomFactor;
    zoom = Math.max(0.3, Math.min(3.5, zoom * zoomFactor));
}, { passive: false });

window.addEventListener('keydown', (e) => {
    // Skip shortcut processing if user is editing text in an input or textarea
    const activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') {
        return;
    }

    if (e.code === 'Space') {
        if (!spacePressed) {
            spacePressed = true;
            canvas.style.cursor = 'grab';
        }
        // If scrubbed, space exits scrub and resumes sweep; otherwise toggles play/pause
        if (scrubbedTimeMs !== null) {
            resumeSweep();
        } else if (typeof togglePlayPause === 'function') {
            togglePlayPause();
        }
        e.preventDefault();
        return;
    }

    if ((e.key === 'r' || e.key === 'R') && selectedComp) {
        rotateSelected();
        return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedComp) {
        deleteSelected();
        return;
    }

    // Oscilloscope & Transient Duration Shortcuts
    if (graphViewMode === 'transient') {
        if (e.key === '1') {
            setTransientViewDuration(20);
        } else if (e.key === '2') {
            setTransientViewDuration(50);
        } else if (e.key === '3') {
            setTransientViewDuration(100);
        } else if (e.key === '4') {
            setTransientViewDuration(200);
        } else if (e.key === '0') {
            setTransientViewDuration('all');
        } else if (e.key === '[') {
            // Step down viewing duration
            const cur = transientViewDurationMs !== null ? transientViewDurationMs : 200;
            const presets = [20, 50, 100, 200];
            let nextVal = presets[0];
            for (let i = presets.length - 1; i >= 0; i--) {
                if (presets[i] < cur - 0.5) {
                    nextVal = presets[i];
                    break;
                }
            }
            if (cur > 200) nextVal = Math.max(200, cur - 50);
            setTransientViewDuration(nextVal);
        } else if (e.key === ']') {
            // Step up viewing duration
            const cur = transientViewDurationMs !== null ? transientViewDurationMs : 20;
            const presets = [20, 50, 100, 200];
            let nextVal = null;
            for (let i = 0; i < presets.length; i++) {
                if (presets[i] > cur + 0.5) {
                    nextVal = presets[i];
                    break;
                }
            }
            if (nextVal === null) {
                nextVal = cur >= 200 ? Math.min(2000, cur + 50) : 'all';
            }
            setTransientViewDuration(nextVal);
        } else if (e.key === 'ArrowLeft') {
            // Nudge scrubbed time backward
            e.preventDefault();
            const totalMs = (lastSimResults && lastSimResults.time && lastSimResults.time.length > 0) ? lastSimResults.time[lastSimResults.time.length - 1] * 1000.0 : 200;
            const currentMs = (scrubbedTimeMs !== null) ? scrubbedTimeMs : (currentCycleAngleDeg / 360.0) * totalMs;
            const stepMs = Math.max(0.2, (transientViewDurationMs || totalMs) * 0.01);
            onPlotScrub(Math.max(0, currentMs - stepMs));
        } else if (e.key === 'ArrowRight') {
            // Nudge scrubbed time forward
            e.preventDefault();
            const totalMs = (lastSimResults && lastSimResults.time && lastSimResults.time.length > 0) ? lastSimResults.time[lastSimResults.time.length - 1] * 1000.0 : 200;
            const currentMs = (scrubbedTimeMs !== null) ? scrubbedTimeMs : (currentCycleAngleDeg / 360.0) * totalMs;
            const stepMs = Math.max(0.2, (transientViewDurationMs || totalMs) * 0.01);
            onPlotScrub(Math.min(totalMs, currentMs + stepMs));
        }
    }
});

window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
        spacePressed = false;
        canvas.style.cursor = 'default';
    }
});

function findComponentAt(x, y) {
    for (let i = components.length - 1; i >= 0; i--) {
        const c = components[i];
        const dist = distToSegment(x, y, c.p1.x, c.p1.y, c.p2.x, c.p2.y);
        if (dist <= 12) return c;
    }
    return null;
}

function findNearestNode(x, y, maxDist = 20) {
    let nearest = null;
    let minDist = maxDist;
    components.forEach(c => {
        [c.p1, c.p2].forEach(p => {
            const d = Math.hypot(x - p.x, y - p.y);
            if (d < minDist) {
                minDist = d;
                nearest = { x: p.x, y: p.y, id: `N_${Math.round(p.x/gridSize)}_${Math.round(p.y/gridSize)}` };
            }
        });
    });
    return nearest;
}

function distToSegment(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1)**2 + (y2 - y1)**2;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

// -------------------------------------------------------------
// Tool & Selection Controls
// -------------------------------------------------------------
function selectTool(tool) {
    currentTool = tool;
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`tool-${tool}`);
    if (activeBtn) activeBtn.classList.add('active');

    const modeLabel = document.getElementById('canvasModeLabel');
    const probeBanner = document.getElementById('probeBanner');

    if (tool === 'probe_v') {
        modeLabel.innerHTML = '<i class="fa-solid fa-crosshairs text-amber-400"></i> Voltage Probe Mode';
        probeBanner.classList.remove('hidden');
    } else if (tool === 'select') {
        modeLabel.innerHTML = '<i class="fa-solid fa-arrow-pointer text-cyan-400"></i> Select & Move Mode';
        probeBanner.classList.add('hidden');
    } else {
        modeLabel.innerHTML = `<i class="fa-solid fa-pen text-emerald-400"></i> Draw ${tool}`;
        probeBanner.classList.add('hidden');
    }
}

function rotateSelected() {
    if (!selectedComp) return;
    const c = selectedComp;
    const mx = (c.p1.x + c.p2.x) / 2;
    const my = (c.p1.y + c.p2.y) / 2;

    function rotPoint(p) {
        const rx = p.x - mx;
        const ry = p.y - my;
        return {
            x: Math.round((mx - ry) / gridSize) * gridSize,
            y: Math.round((my + rx) / gridSize) * gridSize
        };
    }

    c.p1 = rotPoint(c.p1);
    c.p2 = rotPoint(c.p2);
    invalidateNets();
    triggerAutoSimulate();
}

function deleteSelected() {
    if (!selectedComp) return;
    components = components.filter(c => c !== selectedComp);
    selectedComp = null;
    invalidateNets();
    updatePropsInspector();
    triggerAutoSimulate();
}

function clearCircuit() {
    if (components.length > 0 && !confirm('Clear the entire schematic?')) return;
    components = [];
    groundNodes.clear();
    probedNodes.clear();
    selectedComp = null;
    lastSimResults = null;
    activeChannels.clear();
    invalidateNets();
    updatePropsInspector();
    resetStats();
    resumeSweep();

    // Completely purge and reset the Oscilloscope plot & channel checkboxes
    renderEmptyPlot();
    const chContainer = document.getElementById('channelCheckboxes');
    if (chContainer) chContainer.innerHTML = '<span class="text-slate-500 italic text-xs">Circuit cleared (No channels)</span>';

    const connStatus = document.getElementById('connectionStatus');
    if (connStatus) connStatus.innerHTML = '<span class="w-2 h-2 rounded-full bg-slate-500 inline-block"></span> Schematic Empty';
}

function renderEmptyPlot() {
    if (window.Plotly) {
        Plotly.purge('plot');
        const layout = {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: '#070a13',
            font: { color: '#64748b', size: 10 },
            margin: { l: 45, r: 45, t: 15, b: 35 },
            xaxis: { title: 'Time (ms)', gridcolor: '#1e293b', zerolinecolor: '#334155' },
            yaxis: { title: 'Voltage (V)', gridcolor: '#1e293b', zerolinecolor: '#334155' },
            annotations: [{
                text: 'Oscilloscope Ready — Load a preset or build a circuit',
                xref: 'paper', yref: 'paper',
                x: 0.5, y: 0.5, showarrow: false,
                font: { size: 12, color: '#475569' }
            }]
        };
        Plotly.react('plot', [], layout, { responsive: true, displayModeBar: false });
    }

    const cCanvas = document.getElementById('plotCursorCanvas');
    if (cCanvas) {
        const cctx = cCanvas.getContext('2d');
        if (cctx) cctx.clearRect(0, 0, cCanvas.width, cCanvas.height);
    }
}

function resetZoom() {
    zoom = 1.0;
    panX = 60;
    panY = 60;
}

function toggleNetLabels() {}

// -------------------------------------------------------------
// Properties Inspector Panel (Live parameter changing)
// -------------------------------------------------------------
function updatePropsInspector() {
    const container = document.getElementById('propsContainer');
    const badge = document.getElementById('selectedCompBadge');

    if (!selectedComp) {
        badge.innerText = 'None Selected';
        container.innerHTML = `
            <div class="text-slate-500 italic text-center py-6 flex flex-col items-center gap-2">
                <i class="fa-solid fa-hand-pointer text-2xl text-slate-600"></i>
                <span>Click any component in the schematic to inspect and change its electrical parameters live.</span>
            </div>
        `;
        return;
    }

    const c = selectedComp;
    badge.innerText = `${c.id} (${c.type})`;

    let html = `<div class="flex flex-col gap-3">`;

    if (c.type === 'Resistor') {
        html += renderSliderInput('Resistance', 'value', c.props.value, 0.1, 500, 1, 'Ω');
    } else if (c.type === 'Inductor') {
        html += renderSliderInput('Inductance', 'value', c.props.value, 0.1, 200, 0.5, 'mH');
    } else if (c.type === 'Capacitor') {
        html += renderSliderInput('Capacitance', 'value', c.props.value, 1, 5000, 10, 'µF');
    } else if (c.type === 'V_AC') {
        html += renderSliderInput('Peak Amplitude', 'amplitude', c.props.amplitude, 1, 600, 5, 'V');
        html += renderSliderInput('Frequency', 'freq', c.props.freq, 10, 400, 5, 'Hz');
        html += renderSliderInput('Phase Shift', 'phase', c.props.phase, 0, 360, 5, '°');
    } else if (c.type === 'V_DC') {
        html += renderSliderInput('DC Voltage', 'value', c.props.value, 1, 500, 5, 'V');
    } else if (c.type === 'Thyristor') {
        html += renderSliderInput('Firing Angle (α)', 'delay_angle', c.props.delay_angle, 0, 180, 1, '°');
        html += renderSliderInput('Pulse Width', 'width', c.props.width, 1, 90, 1, '°');
        html += renderSliderInput('Supply Freq', 'freq', c.props.freq, 20, 120, 1, 'Hz');
    } else if (c.type === 'MOSFET') {
        html += `
            <div class="flex flex-col gap-1">
                <label class="text-slate-400 font-semibold text-[11px]">Gate Control Mode</label>
                <select onchange="updateProp('ctrl_type', this.value); triggerAutoSimulate();" class="bg-slate-800 border border-slate-700 text-white rounded p-1 text-xs">
                    <option value="pwm" ${c.props.ctrl_type === 'pwm' ? 'selected' : ''}>PWM Switching (Duty Cycle)</option>
                    <option value="pulse" ${c.props.ctrl_type === 'pulse' ? 'selected' : ''}>Phase Pulse (Delay Angle)</option>
                    <option value="constant" ${c.props.ctrl_type === 'constant' ? 'selected' : ''}>Constant Gate High</option>
                </select>
            </div>
        `;
        if (c.props.ctrl_type === 'pwm') {
            html += renderSliderInput('Switching Frequency', 'freq', c.props.freq, 100, 20000, 100, 'Hz');
            html += renderSliderInput('Duty Cycle (D)', 'duty', c.props.duty, 0, 100, 1, '%');
            html += renderSliderInput('Phase Shift', 'phase', c.props.phase, 0, 360, 5, '°');
        } else if (c.props.ctrl_type === 'pulse') {
            html += renderSliderInput('Delay Angle', 'delay_angle', c.props.delay_angle, 0, 360, 5, '°');
            html += renderSliderInput('Pulse Width', 'width', c.props.width, 1, 180, 5, '°');
        }
        html += renderSliderInput('On-Resistance (Ron)', 'ron', c.props.ron, 0.0001, 0.1, 0.001, 'Ω');
        html += `
            <div class="flex items-center gap-2 mt-1">
                <input type="checkbox" id="bodyDiodeCheck" ${c.props.body_diode ? 'checked' : ''} onchange="updateProp('body_diode', this.checked); triggerAutoSimulate();" class="rounded accent-cyan-500">
                <label for="bodyDiodeCheck" class="text-slate-300">Internal Anti-Parallel Body Diode</label>
            </div>
        `;
    }

    html += `
        <div class="flex gap-2 mt-2 pt-2 border-t border-slate-800">
            <button onclick="rotateSelected()" class="flex-1 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs">
                <i class="fa-solid fa-rotate-right mr-1"></i> Rotate 90°
            </button>
            <button onclick="deleteSelected()" class="flex-1 py-1.5 rounded bg-red-950/70 hover:bg-red-900 text-red-300 border border-red-800/60 text-xs">
                <i class="fa-solid fa-trash mr-1"></i> Delete
            </button>
        </div>
    </div>`;

    container.innerHTML = html;
}

function renderSliderInput(label, propKey, currentVal, min, max, step, unit) {
    return `
        <div class="flex flex-col gap-1">
            <div class="flex justify-between items-center text-[11px]">
                <span class="text-slate-400 font-semibold">${label}</span>
                <span class="font-mono text-cyan-400 font-bold" id="val_${propKey}">${currentVal} ${unit}</span>
            </div>
            <div class="flex items-center gap-2">
                <input type="range" id="range_${propKey}" min="${min}" max="${max}" step="${step}" value="${currentVal}" 
                    oninput="syncParamChange('${propKey}', parseFloat(this.value), '${unit}')" 
                    class="flex-1 h-1 bg-slate-700 rounded-lg cursor-pointer">
                <input type="number" id="num_${propKey}" step="${step}" value="${currentVal}" 
                    oninput="syncParamChange('${propKey}', parseFloat(this.value), '${unit}')" 
                    onchange="syncParamChange('${propKey}', parseFloat(this.value), '${unit}')" 
                    class="w-16 bg-slate-800 border border-slate-700 text-white rounded p-1 text-right text-xs">
            </div>
        </div>
    `;
}

function syncParamChange(propKey, value, unit) {
    if (isNaN(value)) return;
    updateProp(propKey, value);

    const numEl = document.getElementById(`num_${propKey}`);
    const rangeEl = document.getElementById(`range_${propKey}`);
    const valEl = document.getElementById(`val_${propKey}`);

    if (numEl && document.activeElement !== numEl) numEl.value = value;
    if (rangeEl && document.activeElement !== rangeEl) rangeEl.value = value;
    if (valEl) valEl.innerText = `${value} ${unit}`;

    // Auto-trigger simulation live on any parameter adjustment!
    triggerAutoSimulate();
}

function updateProp(key, value) {
    if (!selectedComp) return;
    selectedComp.props[key] = value;
}

// -------------------------------------------------------------
// Live Auto-Simulation (Ultra-Fast 25ms Debounce)
// -------------------------------------------------------------
function triggerAutoSimulate() {
    if (autoSimDebounceTimer) clearTimeout(autoSimDebounceTimer);
    autoSimDebounceTimer = setTimeout(() => {
        runSimulation(true);
    }, 25);
}

// -------------------------------------------------------------
// Simulation Engine Execution & API Routing
// -------------------------------------------------------------
async function runSimulation(isBackgroundAuto = false) {
    if (components.length === 0) return;
    if (groundNodes.size === 0) return;
    if (isSimulating) {
        hasPendingSimulateRequest = true;
        return;
    }

    isSimulating = true;
    const runBtn = document.getElementById('runBtn');
    if (!isBackgroundAuto && runBtn) {
        runBtn.innerHTML = '<i class="fa-solid fa-spinner animate-spin"></i> Solving...';
        runBtn.disabled = true;
    }

    const { netMap } = computeElectricalNets();

    // Determine simulation frequency & adaptive timescale
    let maxFreq = 50.0;
    components.forEach(c => {
        if (c.props && c.props.freq && c.props.freq > maxFreq) {
            maxFreq = c.props.freq;
        }
    });

    simCyclePeriod = 1.0 / maxFreq;

    let t_end = 0.04;
    if (customSimTimeMs !== null) {
        t_end = customSimTimeMs / 1000.0;
    } else {
        t_end = simCycles * (1.0 / maxFreq);
    }
    if (transientViewDurationMs !== null && (transientViewDurationMs / 1000.0) > t_end) {
        t_end = transientViewDurationMs / 1000.0;
    }

    let dt = Math.max(1e-5, (1.0 / maxFreq) / 100.0);
    if (maxFreq >= 1000 && dt > (1.0 / maxFreq) / 50.0) {
        dt = Math.max(1e-6, (1.0 / maxFreq) / 80.0);
    }

    const circuitPayload = {
        simulation: { t_end: t_end, dt: dt, cycle_count: simCycles },
        components: [],
        control: {}
    };

    if (transientViewDurationMs !== null) {
        circuitPayload.window = {
            t_start: (transientViewStartMs || 0) / 1000.0,
            t_end: transientViewDurationMs / 1000.0
        };
        circuitPayload.simulation.window = circuitPayload.window;
    }

    components.forEach(c => {
        if (c.type === 'Wire') return;

        const n1 = netMap[`N_${Math.round(c.p1.x/gridSize)}_${Math.round(c.p1.y/gridSize)}`] || 'GND';
        const n2 = netMap[`N_${Math.round(c.p2.x/gridSize)}_${Math.round(c.p2.y/gridSize)}`] || 'GND';

        const item = {
            id: c.id,
            type: c.type,
            nodes: [n1, n2]
        };

        if (c.type === 'Resistor') {
            item.value = Math.max(c.props.value, 1e-4);
        } else if (c.type === 'Inductor') {
            item.value = Math.max(c.props.value * 1e-3, 1e-6);
        } else if (c.type === 'Capacitor') {
            item.value = Math.max(c.props.value * 1e-6, 1e-9);
            item.v0 = c.props.v0 || 0;
        } else if (c.type === 'V_AC') {
            item.amplitude = c.props.amplitude;
            item.freq = c.props.freq;
            item.phase = (c.props.phase || 0) * Math.PI / 180.0;
            item.phase_unit = 'rad';
        } else if (c.type === 'V_DC') {
            item.value = c.props.value;
        } else if (c.type === 'Diode') {
            item.ron = c.props.ron;
            item.roff = c.props.roff;
        } else if (c.type === 'Thyristor') {
            item.ron = c.props.ron;
            item.roff = c.props.roff;
            circuitPayload.control[c.id] = {
                type: 'pulse',
                delay_angle: c.props.delay_angle,
                width: c.props.width,
                freq: c.props.freq
            };
        } else if (c.type === 'MOSFET') {
            item.ron = c.props.ron;
            item.roff = c.props.roff;
            item.body_diode = c.props.body_diode;
            circuitPayload.control[c.id] = {
                type: c.props.ctrl_type,
                freq: c.props.freq,
                duty: c.props.duty,
                phase: c.props.phase,
                delay_angle: c.props.delay_angle,
                width: c.props.width
            };
        }

        circuitPayload.components.push(item);
    });

    try {
        const response = await fetch('/api/simulate_custom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ circuit_json: circuitPayload })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Solver error');
        }

        const data = await response.json();
        lastSimResults = data;

        // Filter activeChannels to only retain channels that actually exist in new results
        const validChannels = new Set();
        activeChannels.forEach(ch => {
            if (ch.startsWith('V(')) {
                const node = ch.slice(2, -1);
                if (data.nodes[node] !== undefined) validChannels.add(ch);
            } else if (ch.startsWith('I(')) {
                const cid = ch.slice(2, -1);
                if (data.branch_i[cid] !== undefined) validChannels.add(ch);
            } else if (ch.startsWith('State(')) {
                const cid = ch.slice(6, -1);
                if (data.switches[cid] !== undefined) validChannels.add(ch);
            }
        });
        activeChannels = validChannels;

        // Auto-configure channels if empty or no channels valid
        if (activeChannels.size === 0) {
            const rComp = components.find(c => c.type === 'Resistor');
            if (rComp) {
                activeChannels.add(`I(${rComp.id})`);
                const n1 = netMap[`N_${Math.round(rComp.p1.x/gridSize)}_${Math.round(rComp.p1.y/gridSize)}`];
                const n2 = netMap[`N_${Math.round(rComp.p2.x/gridSize)}_${Math.round(rComp.p2.y/gridSize)}`];
                if (n1 && n1 !== 'GND' && n1 !== 'gnd') activeChannels.add(`V(${n1})`);
                else if (n2 && n2 !== 'GND' && n2 !== 'gnd') activeChannels.add(`V(${n2})`);
            }
            const acComp = components.find(c => c.type === 'V_AC');
            if (acComp) {
                const nac = netMap[`N_${Math.round(acComp.p1.x/gridSize)}_${Math.round(acComp.p1.y/gridSize)}`];
                if (nac && nac !== 'GND') activeChannels.add(`V(${nac})`);
            }
            const dcComp = components.find(c => c.type === 'V_DC');
            if (dcComp) {
                const ndc = netMap[`N_${Math.round(dcComp.p1.x/gridSize)}_${Math.round(dcComp.p1.y/gridSize)}`];
                if (ndc && ndc !== 'GND') activeChannels.add(`V(${ndc})`);
            }
            if (activeChannels.size === 0) {
                Object.keys(data.nodes).forEach(n => {
                    if (n !== 'GND' && n !== 'gnd' && n !== '0' && activeChannels.size < 3) activeChannels.add(`V(${n})`);
                });
            }
        }

        syncTransientControlsUI();
        buildChannelToggles();
        updatePlot();
        updateStatsDashboard(data);

        const simTimeLabel = document.getElementById('simTimeLabel');
        if (simTimeLabel) {
            simTimeLabel.innerText = `Simulation Time: ${(t_end * 1000).toFixed(1)} ms (${simCycles} Cycles)`;
        }

        document.getElementById('connectionStatus').innerHTML = `
            <span class="w-2 h-2 rounded-full bg-emerald-400 inline-block animate-pulse"></span> Solved Live (${data.time.length} pts)
        `;

    } catch (err) {
        console.warn('Simulation error:', err.message);
    } finally {
        isSimulating = false;
        if (!isBackgroundAuto && runBtn) {
            runBtn.innerHTML = '<i class="fa-solid fa-play"></i> Run Simulation';
            runBtn.disabled = false;
        }
        if (hasPendingSimulateRequest) {
            hasPendingSimulateRequest = false;
            triggerAutoSimulate();
        }
    }
}

// -------------------------------------------------------------
// Oscilloscope & Waveform Channel Controls
// -------------------------------------------------------------
function buildChannelToggles() {
    const container = document.getElementById('channelCheckboxes');
    if (!lastSimResults) return;

    let html = '';
    const { nodes, branch_i, switches } = lastSimResults;

    Object.keys(nodes).forEach(n => {
        if (n === 'GND' || n === 'gnd' || n === '0') return;
        const key = `V(${n})`;
        const isChecked = activeChannels.has(key);
        html += renderChannelBadge(key, `Node ${n}`, 'cyan', isChecked);
    });

    Object.keys(branch_i).forEach(cid => {
        const key = `I(${cid})`;
        const isChecked = activeChannels.has(key);
        html += renderChannelBadge(key, `${cid} Current`, 'emerald', isChecked);
    });

    Object.keys(switches).forEach(cid => {
        const key = `State(${cid})`;
        const isChecked = activeChannels.has(key);
        html += renderChannelBadge(key, `${cid} State`, 'amber', isChecked);
    });

    container.innerHTML = html;
}

function renderChannelBadge(key, label, color, isChecked) {
    const bgClass = isChecked 
        ? (color === 'cyan' ? 'bg-cyan-900/60 border-cyan-500 text-cyan-300' 
          : (color === 'emerald' ? 'bg-emerald-900/60 border-emerald-500 text-emerald-300' 
          : 'bg-amber-900/60 border-amber-500 text-amber-300'))
        : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300';

    return `
        <button onclick="toggleChannel('${key}')" class="px-2 py-1 rounded border text-[10px] font-mono font-bold transition flex items-center gap-1.5 ${bgClass}">
            <span class="w-1.5 h-1.5 rounded-full ${isChecked ? 'bg-current' : 'bg-slate-700'}"></span>
            ${key}
        </button>
    `;
}

function toggleChannel(key) {
    if (activeChannels.has(key)) {
        activeChannels.delete(key);
    } else {
        activeChannels.add(key);
    }
    buildChannelToggles();
    updatePlot();
}

function toggleAllWaveforms(enableAll) {
    if (!lastSimResults) return;
    if (enableAll) {
        Object.keys(lastSimResults.nodes).forEach(n => { if (n !== 'GND') activeChannels.add(`V(${n})`); });
        Object.keys(lastSimResults.branch_i).forEach(cid => activeChannels.add(`I(${cid})`));
    } else {
        activeChannels.clear();
    }
    buildChannelToggles();
    updatePlot();
}

// Plotly update displaying full backend solver resolution
function updatePlot() {
    if (!lastSimResults) return;
    const { time, nodes, branch_i, switches } = lastSimResults;

    const fullTimeMs = time.map(t => t * 1000.0);
    const total_t_ms = fullTimeMs[fullTimeMs.length - 1];

    let t_start_ms, t_end_ms;
    if (lastSimResults.steady_window && typeof lastSimResults.steady_window.t_start === 'number') {
        t_start_ms = lastSimResults.steady_window.t_start * 1000.0;
        t_end_ms = lastSimResults.steady_window.t_end * 1000.0;
    } else {
        const cycleMs = (simCyclePeriod || 0.02) * 1000.0;
        t_end_ms = total_t_ms;
        t_start_ms = Math.max(0, t_end_ms - cycleMs);
    }

    const traces = [];
    const colorPalette = ['#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#3b82f6', '#14b8a6', '#f97316'];
    let colorIdx = 0;

    activeChannels.forEach(key => {
        const color = colorPalette[colorIdx % colorPalette.length];
        colorIdx++;

        if (key.startsWith('V(')) {
            const node = key.slice(2, -1);
            if (nodes[node]) {
                traces.push({
                    x: fullTimeMs,
                    y: nodes[node],
                    mode: 'lines',
                    name: key,
                    line: { color: color, width: 2 }
                });
            }
        } else if (key.startsWith('I(')) {
            const cid = key.slice(2, -1);
            if (branch_i[cid]) {
                traces.push({
                    x: fullTimeMs,
                    y: branch_i[cid],
                    mode: 'lines',
                    name: key,
                    yaxis: 'y2',
                    line: { color: color, width: 2, dash: 'dot' }
                });
            }
        } else if (key.startsWith('State(')) {
            const cid = key.slice(6, -1);
            if (switches[cid]) {
                traces.push({
                    x: fullTimeMs,
                    y: switches[cid],
                    mode: 'lines',
                    name: key,
                    yaxis: 'y3',
                    line: { color: color, width: 1.5, shape: 'hv' }
                });
            }
        }
    });

    let xAxisConfig = {};
    let plotShapes = [];

    const durationBar = document.getElementById('transientDurationBar');
    if (durationBar) {
        if (graphViewMode === 'transient') {
            durationBar.classList.remove('hidden');
            durationBar.classList.add('flex');
            syncTransientControlsUI();
        } else {
            durationBar.classList.add('hidden');
            durationBar.classList.remove('flex');
        }
    }

    if (graphViewMode === 'steady') {
        xAxisConfig = {
            title: 'Time (ms) [Steady-State Cycle]',
            range: [t_start_ms, t_end_ms],
            autorange: false,
            rangeslider: { visible: false },
            gridcolor: '#1e293b',
            zerolinecolor: '#334155'
        };
        plotShapes = [];
    } else {
        const visibleStartMs = (transientViewStartMs !== null && !isNaN(transientViewStartMs)) ? Math.max(0, transientViewStartMs) : 0;
        const visibleEndMs = transientViewDurationMs !== null ? Math.min(total_t_ms, Math.max(visibleStartMs + 0.1, transientViewDurationMs)) : total_t_ms;
        transientViewEndMs = visibleEndMs;

        xAxisConfig = {
            title: 'Time (ms) [Transient Waveform]',
            range: [visibleStartMs, visibleEndMs],
            autorange: false,
            rangeslider: {
                visible: true,
                bgcolor: '#0b1120',
                bordercolor: '#1e293b',
                thickness: 0.08
            },
            gridcolor: '#1e293b',
            zerolinecolor: '#334155'
        };
        plotShapes = [{
            type: 'rect',
            xref: 'x',
            yref: 'paper',
            x0: t_start_ms,
            x1: t_end_ms,
            y0: 0,
            y1: 1,
            fillcolor: 'rgba(6, 182, 212, 0.12)',
            line: { color: '#06b6d4', width: 1, dash: 'dot' }
        }];
    }

    const layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: '#070a13',
        autosize: true,
        font: { color: '#94a3b8', size: 10 },
        margin: { l: 45, r: 45, t: 20, b: 35 },
        hovermode: 'x unified',
        xaxis: xAxisConfig,
        shapes: plotShapes,
        yaxis: {
            title: 'Voltage (V)',
            gridcolor: '#1e293b',
            zerolinecolor: '#334155'
        },
        yaxis2: {
            title: 'Current (A)',
            overlaying: 'y',
            side: 'right',
            gridcolor: 'rgba(0,0,0,0)',
            zerolinecolor: '#334155'
        },
        yaxis3: {
            title: 'State',
            overlaying: 'y',
            side: 'right',
            showgrid: false,
            range: [-0.1, 1.2],
            showticklabels: false
        },
        legend: {
            orientation: 'h',
            y: 1.15,
            x: 0,
            font: { size: 10 }
        }
    };

    isInternalPlotUpdate = true;
    Plotly.react('plot', traces, layout, { responsive: true, displayModeBar: false }).then(() => {
        isInternalPlotUpdate = false;
        setupPlotInteractions();
    });
}

function setupPlotInteractions() {
    const plotEl = document.getElementById('plot');
    if (!plotEl || plotInteractionsSetup) return;
    plotInteractionsSetup = true;

    if (plotEl.on) {
        plotEl.on('plotly_click', function(data) {
            if (data && data.points && data.points.length > 0) {
                onPlotScrub(data.points[0].x);
            }
        });

        plotEl.on('plotly_relayout', function(eventData) {
            if (!eventData || isInternalPlotUpdate || graphViewMode !== 'transient') return;
            handlePlotlyRelayout(eventData);
        });
    }

    plotEl.addEventListener('click', function(e) {
        if (!lastSimResults) return;
        const rect = plotEl.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;

        // If clicked on/near cursor head while scrubbed, resume continuous sweep
        if (scrubbedTimeMs !== null && lastCursorX >= 0) {
            const dist = Math.hypot(clickX - lastCursorX, clickY - lastCursorHeadY);
            if (dist < 22) {
                resumeSweep();
                return;
            }
        }

        // Convert clickX to ms from Plotly layout size & range
        if (plotEl._fullLayout && plotEl._fullLayout.xaxis && plotEl._fullLayout._size) {
            const sz = plotEl._fullLayout._size;
            if (clickX >= sz.l && clickX <= sz.l + sz.w && clickY >= sz.t && clickY <= sz.t + sz.h) {
                const fraction = (clickX - sz.l) / sz.w;
                const xRange = plotEl._fullLayout.xaxis.range;
                if (xRange && xRange.length >= 2) {
                    const clickedMs = xRange[0] + fraction * (xRange[1] - xRange[0]);
                    onPlotScrub(clickedMs);
                }
            }
        }
    });

    plotEl.addEventListener('mousemove', function(e) {
        if (scrubbedTimeMs !== null && lastCursorX >= 0) {
            const rect = plotEl.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            if (Math.hypot(mouseX - lastCursorX, mouseY - lastCursorHeadY) < 22) {
                plotEl.style.cursor = 'pointer';
                return;
            }
        }
        plotEl.style.cursor = '';
    });
}

function updateStatsDashboard(data) {
    if (!data) return;

    let statsObj = null;
    if (graphViewMode === 'steady') {
        statsObj = data.stats_steady || computeSteadyStatsSlice(data) || data.stats;
    } else {
        const isCustomWindow = (transientViewDurationMs !== null || transientViewStartMs > 0);
        if (isCustomWindow) {
            const startSec = (transientViewStartMs || 0) / 1000.0;
            const endSec = (transientViewEndMs !== null ? transientViewEndMs : (transientViewDurationMs || 0)) / 1000.0;
            statsObj = data.stats_window || computeWindowStatsSlice(data, startSec, endSec) || data.stats_transient || data.stats;
        } else {
            statsObj = data.stats_transient || data.stats;
        }
    }
    if (!statsObj) return;

    const rComp = components.find(c => c.type === 'Resistor');
    let avgV = 0, rmsV = 0, avgI = 0, rmsI = 0, power = 0, rf = 0;

    if (rComp) {
        const iStats = statsObj[`I(${rComp.id})`];
        if (iStats) {
            avgI = iStats.avg;
            rmsI = iStats.rms;
            power = iStats.p_avg !== undefined ? iStats.p_avg : (iStats.power || 0);
        }
    }

    const nodeKeys = Object.keys(data.nodes).filter(n => n !== 'GND' && n !== 'gnd');
    if (nodeKeys.length > 0) {
        const vStats = statsObj[`V(${nodeKeys[0]})`];
        if (vStats) {
            avgV = vStats.avg;
            rmsV = vStats.rms;
            rf = vStats.rf !== undefined ? vStats.rf : 0;
        }
    }

    document.getElementById('statAvgV').innerText = `${avgV.toFixed(1)} V`;
    document.getElementById('statRmsV').innerText = `${rmsV.toFixed(1)} V`;
    document.getElementById('statAvgI').innerText = `${avgI.toFixed(2)} A`;
    document.getElementById('statRmsI').innerText = `${rmsI.toFixed(2)} A`;
    document.getElementById('statPower').innerText = `${Math.abs(power).toFixed(1)} W`;
    document.getElementById('statRF').innerText = `${rf.toFixed(3)}`;
}

function computeSteadyStatsSlice(data) {
    if (!data.time || data.time.length === 0) return null;
    const times = data.time;
    const totalSimTime = times[times.length - 1];
    let t_start = 0;
    if (data.steady_window && typeof data.steady_window.t_start === 'number') {
        t_start = data.steady_window.t_start;
    } else {
        t_start = Math.max(0, totalSimTime - simCyclePeriod);
    }

    let sIdx = 0;
    let low = 0, high = times.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (times[mid] < t_start) low = mid + 1;
        else { sIdx = mid; high = mid - 1; }
    }
    const count = times.length - sIdx;
    if (count <= 1) return null;

    const steadyStats = {};
    if (data.nodes) {
        for (const [node, arr] of Object.entries(data.nodes)) {
            let sum = 0, sumSq = 0;
            for (let i = sIdx; i < arr.length; i++) {
                const v = arr[i];
                sum += v;
                sumSq += v * v;
            }
            const avg = sum / count;
            const rms = Math.sqrt(sumSq / count);
            const rf = Math.abs(avg) > 1e-6 ? Math.sqrt(Math.max(0, Math.pow(rms / Math.abs(avg), 2) - 1.0)) : 0;
            steadyStats[`V(${node})`] = { avg, rms, rf };
        }
    }
    if (data.branch_i) {
        for (const [cid, arr] of Object.entries(data.branch_i)) {
            let sum = 0, sumSq = 0, sumP = 0;
            const vArr = (data.branch_v && data.branch_v[cid]) || null;
            for (let i = sIdx; i < arr.length; i++) {
                const cur = arr[i];
                sum += cur;
                sumSq += cur * cur;
                if (vArr && vArr.length > i) sumP += cur * vArr[i];
            }
            const avg = sum / count;
            const rms = Math.sqrt(sumSq / count);
            const rf = Math.abs(avg) > 1e-6 ? Math.sqrt(Math.max(0, Math.pow(rms / Math.abs(avg), 2) - 1.0)) : 0;
            steadyStats[`I(${cid})`] = { avg, rms, p_avg: sumP / count, rf };
        }
    }
    return steadyStats;
}

function computeWindowStatsSlice(data, startSec, endSec) {
    if (!data.time || data.time.length === 0) return null;
    const times = data.time;
    const totalSimTime = times[times.length - 1];
    const t0 = Math.max(0, Math.min(totalSimTime, startSec || 0));
    const t1 = Math.max(t0 + 1e-6, Math.min(totalSimTime, endSec || totalSimTime));

    let sIdx = 0;
    let low = 0, high = times.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (times[mid] < t0) low = mid + 1;
        else { sIdx = mid; high = mid - 1; }
    }

    let eIdx = times.length - 1;
    low = sIdx;
    high = times.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (times[mid] <= t1) { eIdx = mid; low = mid + 1; }
        else high = mid - 1;
    }

    const count = eIdx - sIdx + 1;
    if (count <= 1) return null;

    const windowStats = {};
    if (data.nodes) {
        for (const [node, arr] of Object.entries(data.nodes)) {
            let sum = 0, sumSq = 0;
            for (let i = sIdx; i <= eIdx; i++) {
                const v = arr[i];
                sum += v;
                sumSq += v * v;
            }
            const avg = sum / count;
            const rms = Math.sqrt(sumSq / count);
            const rf = Math.abs(avg) > 1e-6 ? Math.sqrt(Math.max(0, Math.pow(rms / Math.abs(avg), 2) - 1.0)) : 0;
            windowStats[`V(${node})`] = { avg, rms, rf };
        }
    }
    if (data.branch_i) {
        for (const [cid, arr] of Object.entries(data.branch_i)) {
            let sum = 0, sumSq = 0, sumP = 0;
            const vArr = (data.branch_v && data.branch_v[cid]) || null;
            for (let i = sIdx; i <= eIdx; i++) {
                const cur = arr[i];
                sum += cur;
                sumSq += cur * cur;
                if (vArr && vArr.length > i) sumP += cur * vArr[i];
            }
            const avg = sum / count;
            const rms = Math.sqrt(sumSq / count);
            const rf = Math.abs(avg) > 1e-6 ? Math.sqrt(Math.max(0, Math.pow(rms / Math.abs(avg), 2) - 1.0)) : 0;
            windowStats[`I(${cid})`] = { avg, rms, p_avg: sumP / count, rf };
        }
    }
    return windowStats;
}

function resetStats() {
    ['statAvgV', 'statRmsV', 'statAvgI', 'statRmsI', 'statPower', 'statRF'].forEach(id => {
        document.getElementById(id).innerText = '--';
    });
}

// -------------------------------------------------------------
// Circuit Presets
// -------------------------------------------------------------
function loadPreset(name) {
    components = [];
    groundNodes.clear();
    probedNodes.clear();
    activeChannels.clear();
    compIdCounter = 1;
    selectedComp = null;
    lastSimResults = null;
    hasPendingSimulateRequest = false;
    renderEmptyPlot();
    updatePropsInspector();
    resetStats();
    resumeSweep();

    // ---------------------------------------------------------
    // 1. Single-Phase Full-Bridge Thyristor Rectifier (Reference)
    // ---------------------------------------------------------
    if (name === 'full_bridge_thyristor' || name === 'scr_bridge') {
        const ox = 150, oy = 90;

        components.push(createComponent('V_AC', { x: ox, y: oy + 90 }, { x: ox, y: oy + 150 }));
        components.find(c => c.type === 'V_AC').props = { amplitude: 325, freq: 50, phase: 0 };

        const t1 = createComponent('Thyristor', { x: ox + 90, y: oy + 90 }, { x: ox + 90, y: oy });
        t1.id = 'T1';
        t1.props = { delay_angle: 45, width: 20, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t1);

        const t4 = createComponent('Thyristor', { x: ox + 90, y: oy + 240 }, { x: ox + 90, y: oy + 90 });
        t4.id = 'T4';
        t4.props = { delay_angle: 225, width: 20, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t4);

        const t3 = createComponent('Thyristor', { x: ox + 180, y: oy + 150 }, { x: ox + 180, y: oy });
        t3.id = 'T3';
        t3.props = { delay_angle: 225, width: 20, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t3);

        const t2 = createComponent('Thyristor', { x: ox + 180, y: oy + 240 }, { x: ox + 180, y: oy + 150 });
        t2.id = 'T2';
        t2.props = { delay_angle: 45, width: 20, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t2);

        components.push(createComponent('Wire', { x: ox, y: oy + 90 }, { x: ox + 90, y: oy + 90 }));
        components.push(createComponent('Wire', { x: ox, y: oy + 150 }, { x: ox + 180, y: oy + 150 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy }, { x: ox + 180, y: oy }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 270, y: oy }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 240 }, { x: ox + 180, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 240 }, { x: ox + 270, y: oy + 240 }));

        const l1 = createComponent('Inductor', { x: ox + 270, y: oy }, { x: ox + 270, y: oy + 120 });
        l1.props = { value: 45 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 270, y: oy + 120 }, { x: ox + 270, y: oy + 240 });
        r1.props = { value: 20 };
        components.push(r1);

        groundNodes.add(`N_${Math.round((ox + 270)/gridSize)}_${Math.round((oy + 240)/gridSize)}`);

    // ---------------------------------------------------------
    // 2. DC-DC Buck Converter
    // ---------------------------------------------------------
    } else if (name === 'mosfet_buck' || name === 'buck') {
        const ox = 150, oy = 120;

        const vdc = createComponent('V_DC', { x: ox, y: oy }, { x: ox, y: oy + 120 });
        vdc.props = { value: 100 };
        components.push(vdc);

        const m1 = createComponent('MOSFET', { x: ox, y: oy }, { x: ox + 90, y: oy });
        m1.props = { ctrl_type: 'pwm', freq: 5000, duty: 50, phase: 0, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m1);

        const d1 = createComponent('Diode', { x: ox + 90, y: oy + 120 }, { x: ox + 90, y: oy });
        components.push(d1);

        const l1 = createComponent('Inductor', { x: ox + 90, y: oy }, { x: ox + 180, y: oy });
        l1.props = { value: 5 };
        components.push(l1);

        const c1 = createComponent('Capacitor', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 120 });
        c1.props = { value: 220, v0: 50 };
        components.push(c1);

        const r1 = createComponent('Resistor', { x: ox + 240, y: oy }, { x: ox + 240, y: oy + 120 });
        r1.props = { value: 10 };
        components.push(r1);

        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 240, y: oy }));
        components.push(createComponent('Wire', { x: ox, y: oy + 120 }, { x: ox + 90, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 120 }, { x: ox + 180, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 120 }, { x: ox + 240, y: oy + 120 }));

        groundNodes.add(`N_${Math.round((ox + 90)/gridSize)}_${Math.round((oy + 120)/gridSize)}`);

    // ---------------------------------------------------------
    // 3. DC-DC Boost Converter
    // ---------------------------------------------------------
    } else if (name === 'mosfet_boost' || name === 'boost') {
        const ox = 150, oy = 120;

        const vdc = createComponent('V_DC', { x: ox, y: oy }, { x: ox, y: oy + 120 });
        vdc.props = { value: 48 };
        components.push(vdc);

        const l1 = createComponent('Inductor', { x: ox, y: oy }, { x: ox + 90, y: oy });
        l1.props = { value: 10 };
        components.push(l1);

        const m1 = createComponent('MOSFET', { x: ox + 90, y: oy }, { x: ox + 90, y: oy + 120 });
        m1.props = { ctrl_type: 'pwm', freq: 5000, duty: 50, phase: 0, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m1);

        const d1 = createComponent('Diode', { x: ox + 90, y: oy }, { x: ox + 180, y: oy });
        components.push(d1);

        const c1 = createComponent('Capacitor', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 120 });
        c1.props = { value: 220, v0: 96 };
        components.push(c1);

        const r1 = createComponent('Resistor', { x: ox + 240, y: oy }, { x: ox + 240, y: oy + 120 });
        r1.props = { value: 25 };
        components.push(r1);

        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 240, y: oy }));
        components.push(createComponent('Wire', { x: ox, y: oy + 120 }, { x: ox + 90, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 120 }, { x: ox + 180, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 120 }, { x: ox + 240, y: oy + 120 }));

        groundNodes.add(`N_${Math.round((ox + 90)/gridSize)}_${Math.round((oy + 120)/gridSize)}`);

    // ---------------------------------------------------------
    // 4. DC-DC Buck-Boost Converter
    // ---------------------------------------------------------
    } else if (name === 'buck_boost') {
        const ox = 150, oy = 120;

        const vdc = createComponent('V_DC', { x: ox, y: oy }, { x: ox, y: oy + 120 });
        vdc.props = { value: 50 };
        components.push(vdc);

        const m1 = createComponent('MOSFET', { x: ox, y: oy }, { x: ox + 90, y: oy });
        m1.props = { ctrl_type: 'pwm', freq: 5000, duty: 50, phase: 0, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m1);

        const l1 = createComponent('Inductor', { x: ox + 90, y: oy }, { x: ox + 90, y: oy + 120 });
        l1.props = { value: 8 };
        components.push(l1);

        const d1 = createComponent('Diode', { x: ox + 180, y: oy }, { x: ox + 90, y: oy });
        components.push(d1);

        const c1 = createComponent('Capacitor', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 120 });
        c1.props = { value: 220, v0: -50 };
        components.push(c1);

        const r1 = createComponent('Resistor', { x: ox + 240, y: oy }, { x: ox + 240, y: oy + 120 });
        r1.props = { value: 20 };
        components.push(r1);

        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 240, y: oy }));
        components.push(createComponent('Wire', { x: ox, y: oy + 120 }, { x: ox + 90, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 120 }, { x: ox + 180, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 120 }, { x: ox + 240, y: oy + 120 }));

        groundNodes.add(`N_${Math.round((ox + 90)/gridSize)}_${Math.round((oy + 120)/gridSize)}`);

    // ---------------------------------------------------------
    // 5. DC-DC Cuk Converter
    // ---------------------------------------------------------
    } else if (name === 'cuk') {
        const ox = 120, oy = 120;

        const vdc = createComponent('V_DC', { x: ox, y: oy }, { x: ox, y: oy + 120 });
        vdc.props = { value: 50 };
        components.push(vdc);

        const l1 = createComponent('Inductor', { x: ox, y: oy }, { x: ox + 90, y: oy });
        l1.props = { value: 10 };
        components.push(l1);

        const m1 = createComponent('MOSFET', { x: ox + 90, y: oy }, { x: ox + 90, y: oy + 120 });
        m1.props = { ctrl_type: 'pwm', freq: 5000, duty: 50, phase: 0, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m1);

        const c1 = createComponent('Capacitor', { x: ox + 90, y: oy }, { x: ox + 180, y: oy });
        c1.props = { value: 47, v0: 100 };
        components.push(c1);

        const d1 = createComponent('Diode', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 120 });
        components.push(d1);

        const l2 = createComponent('Inductor', { x: ox + 180, y: oy }, { x: ox + 270, y: oy });
        l2.props = { value: 10 };
        components.push(l2);

        const c2 = createComponent('Capacitor', { x: ox + 270, y: oy }, { x: ox + 270, y: oy + 120 });
        c2.props = { value: 220, v0: -50 };
        components.push(c2);

        const r1 = createComponent('Resistor', { x: ox + 330, y: oy }, { x: ox + 330, y: oy + 120 });
        r1.props = { value: 20 };
        components.push(r1);

        components.push(createComponent('Wire', { x: ox + 270, y: oy }, { x: ox + 330, y: oy }));
        components.push(createComponent('Wire', { x: ox, y: oy + 120 }, { x: ox + 90, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 120 }, { x: ox + 180, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 120 }, { x: ox + 270, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 270, y: oy + 120 }, { x: ox + 330, y: oy + 120 }));

        groundNodes.add(`N_${Math.round((ox + 90)/gridSize)}_${Math.round((oy + 120)/gridSize)}`);

    // ---------------------------------------------------------
    // 6. DC-DC SEPIC Converter
    // ---------------------------------------------------------
    } else if (name === 'sepic') {
        const ox = 120, oy = 120;

        const vdc = createComponent('V_DC', { x: ox, y: oy }, { x: ox, y: oy + 120 });
        vdc.props = { value: 48 };
        components.push(vdc);

        const l1 = createComponent('Inductor', { x: ox, y: oy }, { x: ox + 90, y: oy });
        l1.props = { value: 10 };
        components.push(l1);

        const m1 = createComponent('MOSFET', { x: ox + 90, y: oy }, { x: ox + 90, y: oy + 120 });
        m1.props = { ctrl_type: 'pwm', freq: 5000, duty: 50, phase: 0, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m1);

        const c1 = createComponent('Capacitor', { x: ox + 90, y: oy }, { x: ox + 180, y: oy });
        c1.props = { value: 47, v0: 48 };
        components.push(c1);

        const l2 = createComponent('Inductor', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 120 });
        l2.props = { value: 10 };
        components.push(l2);

        const d1 = createComponent('Diode', { x: ox + 180, y: oy }, { x: ox + 270, y: oy });
        components.push(d1);

        const c2 = createComponent('Capacitor', { x: ox + 270, y: oy }, { x: ox + 270, y: oy + 120 });
        c2.props = { value: 220, v0: 48 };
        components.push(c2);

        const r1 = createComponent('Resistor', { x: ox + 330, y: oy }, { x: ox + 330, y: oy + 120 });
        r1.props = { value: 25 };
        components.push(r1);

        components.push(createComponent('Wire', { x: ox + 270, y: oy }, { x: ox + 330, y: oy }));
        components.push(createComponent('Wire', { x: ox, y: oy + 120 }, { x: ox + 90, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 120 }, { x: ox + 180, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 120 }, { x: ox + 270, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 270, y: oy + 120 }, { x: ox + 330, y: oy + 120 }));

        groundNodes.add(`N_${Math.round((ox + 90)/gridSize)}_${Math.round((oy + 120)/gridSize)}`);

    // ---------------------------------------------------------
    // 7. 1-Phase Half-Wave Diode Rectifier
    // ---------------------------------------------------------
    } else if (name === 'half_wave' || name === 'half_wave_diode') {
        const ox = 180, oy = 120;
        components.push(createComponent('V_AC', { x: ox, y: oy }, { x: ox, y: oy + 120 }));
        components.find(c => c.type === 'V_AC').props = { amplitude: 325, freq: 50, phase: 0 };

        components.push(createComponent('Diode', { x: ox, y: oy }, { x: ox + 90, y: oy }));

        const l1 = createComponent('Inductor', { x: ox + 90, y: oy }, { x: ox + 180, y: oy });
        l1.props = { value: 45 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 120 });
        r1.props = { value: 20 };
        components.push(r1);

        components.push(createComponent('Wire', { x: ox, y: oy + 120 }, { x: ox + 180, y: oy + 120 }));
        groundNodes.add(`N_${Math.round(ox/gridSize)}_${Math.round((oy + 120)/gridSize)}`);

    // ---------------------------------------------------------
    // 8. 1-Phase Half-Wave Controlled SCR Rectifier
    // ---------------------------------------------------------
    } else if (name === 'half_wave_scr') {
        const ox = 180, oy = 120;
        components.push(createComponent('V_AC', { x: ox, y: oy }, { x: ox, y: oy + 120 }));
        components.find(c => c.type === 'V_AC').props = { amplitude: 325, freq: 50, phase: 0 };

        const t1 = createComponent('Thyristor', { x: ox, y: oy }, { x: ox + 90, y: oy });
        t1.props = { delay_angle: 45, width: 25, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t1);

        const l1 = createComponent('Inductor', { x: ox + 90, y: oy }, { x: ox + 180, y: oy });
        l1.props = { value: 45 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 120 });
        r1.props = { value: 20 };
        components.push(r1);

        components.push(createComponent('Wire', { x: ox, y: oy + 120 }, { x: ox + 180, y: oy + 120 }));
        groundNodes.add(`N_${Math.round(ox/gridSize)}_${Math.round((oy + 120)/gridSize)}`);

    // ---------------------------------------------------------
    // 9. 1-Phase Full-Bridge Diode Rectifier
    // ---------------------------------------------------------
    } else if (name === 'full_bridge_diode') {
        const ox = 150, oy = 90;
        components.push(createComponent('V_AC', { x: ox, y: oy + 90 }, { x: ox, y: oy + 150 }));
        components.find(c => c.type === 'V_AC').props = { amplitude: 325, freq: 50, phase: 0 };

        components.push(createComponent('Diode', { x: ox + 90, y: oy + 90 }, { x: ox + 90, y: oy })); // D1
        components.push(createComponent('Diode', { x: ox + 90, y: oy + 240 }, { x: ox + 90, y: oy + 90 })); // D4
        components.push(createComponent('Diode', { x: ox + 180, y: oy + 150 }, { x: ox + 180, y: oy })); // D3
        components.push(createComponent('Diode', { x: ox + 180, y: oy + 240 }, { x: ox + 180, y: oy + 150 })); // D2

        components.push(createComponent('Wire', { x: ox, y: oy + 90 }, { x: ox + 90, y: oy + 90 }));
        components.push(createComponent('Wire', { x: ox, y: oy + 150 }, { x: ox + 180, y: oy + 150 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy }, { x: ox + 180, y: oy }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 270, y: oy }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 240 }, { x: ox + 180, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 240 }, { x: ox + 270, y: oy + 240 }));

        const l1 = createComponent('Inductor', { x: ox + 270, y: oy }, { x: ox + 270, y: oy + 120 });
        l1.props = { value: 45 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 270, y: oy + 120 }, { x: ox + 270, y: oy + 240 });
        r1.props = { value: 20 };
        components.push(r1);

        groundNodes.add(`N_${Math.round((ox + 270)/gridSize)}_${Math.round((oy + 240)/gridSize)}`);

    // ---------------------------------------------------------
    // 10. 1-Phase Semi-Converter (2 SCR, 2 Diode + Freewheeling)
    // ---------------------------------------------------------
    } else if (name === 'semi_converter') {
        const ox = 150, oy = 90;
        components.push(createComponent('V_AC', { x: ox, y: oy + 90 }, { x: ox, y: oy + 150 }));
        components.find(c => c.type === 'V_AC').props = { amplitude: 325, freq: 50, phase: 0 };

        const t1 = createComponent('Thyristor', { x: ox + 90, y: oy + 90 }, { x: ox + 90, y: oy });
        t1.props = { delay_angle: 45, width: 25, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t1);

        const d4 = createComponent('Diode', { x: ox + 90, y: oy + 240 }, { x: ox + 90, y: oy + 90 });
        components.push(d4);

        const t3 = createComponent('Thyristor', { x: ox + 180, y: oy + 150 }, { x: ox + 180, y: oy });
        t3.props = { delay_angle: 225, width: 25, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t3);

        const d2 = createComponent('Diode', { x: ox + 180, y: oy + 240 }, { x: ox + 180, y: oy + 150 });
        components.push(d2);

        const dfw = createComponent('Diode', { x: ox + 240, y: oy + 240 }, { x: ox + 240, y: oy });
        components.push(dfw);

        components.push(createComponent('Wire', { x: ox, y: oy + 90 }, { x: ox + 90, y: oy + 90 }));
        components.push(createComponent('Wire', { x: ox, y: oy + 150 }, { x: ox + 180, y: oy + 150 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy }, { x: ox + 180, y: oy }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 240, y: oy }));
        components.push(createComponent('Wire', { x: ox + 240, y: oy }, { x: ox + 300, y: oy }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 240 }, { x: ox + 180, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 240 }, { x: ox + 240, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 240, y: oy + 240 }, { x: ox + 300, y: oy + 240 }));

        const l1 = createComponent('Inductor', { x: ox + 300, y: oy }, { x: ox + 300, y: oy + 120 });
        l1.props = { value: 45 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 300, y: oy + 120 }, { x: ox + 300, y: oy + 240 });
        r1.props = { value: 20 };
        components.push(r1);

        groundNodes.add(`N_${Math.round((ox + 300)/gridSize)}_${Math.round((oy + 240)/gridSize)}`);

    // ---------------------------------------------------------
    // ---------------------------------------------------------
    // 11. 3-Phase 6-Diode Bridge Rectifier
    // ---------------------------------------------------------
    } else if (name === 'three_phase_bridge_diode') {
        const ox = 90, oy = 90;

        const va = createComponent('V_AC', { x: ox + 90, y: oy + 60 }, { x: ox, y: oy + 120 });
        va.props = { amplitude: 325, freq: 50, phase: 0 };
        components.push(va);

        const vb = createComponent('V_AC', { x: ox + 90, y: oy + 120 }, { x: ox, y: oy + 120 });
        vb.props = { amplitude: 325, freq: 50, phase: -120 };
        components.push(vb);

        const vc = createComponent('V_AC', { x: ox + 90, y: oy + 180 }, { x: ox, y: oy + 120 });
        vc.props = { amplitude: 325, freq: 50, phase: 120 };
        components.push(vc);

        components.push(createComponent('Wire', { x: ox + 90, y: oy + 60 }, { x: ox + 180, y: oy + 60 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 120 }, { x: ox + 240, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 180 }, { x: ox + 300, y: oy + 180 }));

        components.push(createComponent('Diode', { x: ox + 180, y: oy + 60 }, { x: ox + 180, y: oy })); // D1
        components.push(createComponent('Diode', { x: ox + 240, y: oy + 120 }, { x: ox + 240, y: oy })); // D3
        components.push(createComponent('Diode', { x: ox + 300, y: oy + 180 }, { x: ox + 300, y: oy })); // D5

        components.push(createComponent('Diode', { x: ox + 180, y: oy + 240 }, { x: ox + 180, y: oy + 60 })); // D4
        components.push(createComponent('Diode', { x: ox + 240, y: oy + 240 }, { x: ox + 240, y: oy + 120 })); // D6
        components.push(createComponent('Diode', { x: ox + 300, y: oy + 240 }, { x: ox + 300, y: oy + 180 })); // D2

        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 240, y: oy }));
        components.push(createComponent('Wire', { x: ox + 240, y: oy }, { x: ox + 300, y: oy }));
        components.push(createComponent('Wire', { x: ox + 300, y: oy }, { x: ox + 360, y: oy }));

        components.push(createComponent('Wire', { x: ox + 180, y: oy + 240 }, { x: ox + 240, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 240, y: oy + 240 }, { x: ox + 300, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 300, y: oy + 240 }, { x: ox + 360, y: oy + 240 }));

        const l1 = createComponent('Inductor', { x: ox + 360, y: oy }, { x: ox + 360, y: oy + 120 });
        l1.props = { value: 30 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 360, y: oy + 120 }, { x: ox + 360, y: oy + 240 });
        r1.props = { value: 25 };
        components.push(r1);

        groundNodes.add(`N_${Math.round((ox + 360)/gridSize)}_${Math.round((oy + 240)/gridSize)}`);

    // ---------------------------------------------------------
    // 12. 3-Phase 6-Pulse SCR Bridge Rectifier
    // ---------------------------------------------------------
    } else if (name === 'three_phase_bridge_scr') {
        const ox = 90, oy = 90;

        const va = createComponent('V_AC', { x: ox + 90, y: oy + 60 }, { x: ox, y: oy + 120 });
        va.props = { amplitude: 325, freq: 50, phase: 0 };
        components.push(va);

        const vb = createComponent('V_AC', { x: ox + 90, y: oy + 120 }, { x: ox, y: oy + 120 });
        vb.props = { amplitude: 325, freq: 50, phase: -120 };
        components.push(vb);

        const vc = createComponent('V_AC', { x: ox + 90, y: oy + 180 }, { x: ox, y: oy + 120 });
        vc.props = { amplitude: 325, freq: 50, phase: 120 };
        components.push(vc);

        components.push(createComponent('Wire', { x: ox + 90, y: oy + 60 }, { x: ox + 180, y: oy + 60 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 120 }, { x: ox + 240, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 180 }, { x: ox + 300, y: oy + 180 }));

        const t1 = createComponent('Thyristor', { x: ox + 180, y: oy + 60 }, { x: ox + 180, y: oy });
        t1.props = { delay_angle: 60, width: 60, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t1);

        const t3 = createComponent('Thyristor', { x: ox + 240, y: oy + 120 }, { x: ox + 240, y: oy });
        t3.props = { delay_angle: 180, width: 60, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t3);

        const t5 = createComponent('Thyristor', { x: ox + 300, y: oy + 180 }, { x: ox + 300, y: oy });
        t5.props = { delay_angle: 300, width: 60, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t5);

        const t4 = createComponent('Thyristor', { x: ox + 180, y: oy + 240 }, { x: ox + 180, y: oy + 60 });
        t4.props = { delay_angle: 240, width: 60, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t4);

        const t6 = createComponent('Thyristor', { x: ox + 240, y: oy + 240 }, { x: ox + 240, y: oy + 120 });
        t6.props = { delay_angle: 0, width: 60, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t6);

        const t2 = createComponent('Thyristor', { x: ox + 300, y: oy + 240 }, { x: ox + 300, y: oy + 180 });
        t2.props = { delay_angle: 120, width: 60, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t2);

        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 240, y: oy }));
        components.push(createComponent('Wire', { x: ox + 240, y: oy }, { x: ox + 300, y: oy }));
        components.push(createComponent('Wire', { x: ox + 300, y: oy }, { x: ox + 360, y: oy }));

        components.push(createComponent('Wire', { x: ox + 180, y: oy + 240 }, { x: ox + 240, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 240, y: oy + 240 }, { x: ox + 300, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 300, y: oy + 240 }, { x: ox + 360, y: oy + 240 }));

        const l1 = createComponent('Inductor', { x: ox + 360, y: oy }, { x: ox + 360, y: oy + 120 });
        l1.props = { value: 45 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 360, y: oy + 120 }, { x: ox + 360, y: oy + 240 });
        r1.props = { value: 20 };
        components.push(r1);

        groundNodes.add(`N_${Math.round((ox + 360)/gridSize)}_${Math.round((oy + 240)/gridSize)}`);

    // ---------------------------------------------------------
    // 13. 3-Phase Half-Wave Diode Rectifier
    // ---------------------------------------------------------
    } else if (name === 'three_phase_half_wave_diode') {
        const ox = 120, oy = 90;

        const va = createComponent('V_AC', { x: ox + 90, y: oy }, { x: ox, y: oy + 180 });
        va.props = { amplitude: 325, freq: 50, phase: 0 };
        components.push(va);

        const vb = createComponent('V_AC', { x: ox + 90, y: oy + 60 }, { x: ox, y: oy + 180 });
        vb.props = { amplitude: 325, freq: 50, phase: -120 };
        components.push(vb);

        const vc = createComponent('V_AC', { x: ox + 90, y: oy + 120 }, { x: ox, y: oy + 180 });
        vc.props = { amplitude: 325, freq: 50, phase: 120 };
        components.push(vc);

        components.push(createComponent('Diode', { x: ox + 90, y: oy }, { x: ox + 180, y: oy }));
        components.push(createComponent('Diode', { x: ox + 90, y: oy + 60 }, { x: ox + 180, y: oy + 60 }));
        components.push(createComponent('Diode', { x: ox + 90, y: oy + 120 }, { x: ox + 180, y: oy + 120 }));

        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 60 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 60 }, { x: ox + 180, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 240, y: oy }));

        const l1 = createComponent('Inductor', { x: ox + 240, y: oy }, { x: ox + 240, y: oy + 90 });
        l1.props = { value: 30 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 240, y: oy + 90 }, { x: ox + 240, y: oy + 180 });
        r1.props = { value: 20 };
        components.push(r1);

        components.push(createComponent('Wire', { x: ox, y: oy + 180 }, { x: ox + 240, y: oy + 180 }));
        groundNodes.add(`N_${Math.round(ox/gridSize)}_${Math.round((oy + 180)/gridSize)}`);

    // ---------------------------------------------------------
    // 14. 3-Phase Half-Wave Controlled SCR Rectifier
    // ---------------------------------------------------------
    } else if (name === 'three_phase_half_wave_scr') {
        const ox = 120, oy = 90;

        const va = createComponent('V_AC', { x: ox + 90, y: oy }, { x: ox, y: oy + 180 });
        va.props = { amplitude: 325, freq: 50, phase: 0 };
        components.push(va);

        const vb = createComponent('V_AC', { x: ox + 90, y: oy + 60 }, { x: ox, y: oy + 180 });
        vb.props = { amplitude: 325, freq: 50, phase: -120 };
        components.push(vb);

        const vc = createComponent('V_AC', { x: ox + 90, y: oy + 120 }, { x: ox, y: oy + 180 });
        vc.props = { amplitude: 325, freq: 50, phase: 120 };
        components.push(vc);

        const t1 = createComponent('Thyristor', { x: ox + 90, y: oy }, { x: ox + 180, y: oy });
        t1.props = { delay_angle: 60, width: 120, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t1);

        const t2 = createComponent('Thyristor', { x: ox + 90, y: oy + 60 }, { x: ox + 180, y: oy + 60 });
        t2.props = { delay_angle: 180, width: 120, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t2);

        const t3 = createComponent('Thyristor', { x: ox + 90, y: oy + 120 }, { x: ox + 180, y: oy + 120 });
        t3.props = { delay_angle: 300, width: 120, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t3);

        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 60 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 60 }, { x: ox + 180, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 240, y: oy }));

        const l1 = createComponent('Inductor', { x: ox + 240, y: oy }, { x: ox + 240, y: oy + 90 });
        l1.props = { value: 30 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 240, y: oy + 90 }, { x: ox + 240, y: oy + 180 });
        r1.props = { value: 20 };
        components.push(r1);

        components.push(createComponent('Wire', { x: ox, y: oy + 180 }, { x: ox + 240, y: oy + 180 }));
        groundNodes.add(`N_${Math.round(ox/gridSize)}_${Math.round((oy + 180)/gridSize)}`);

    // ---------------------------------------------------------
    // 15. 3-Phase Semi-Converter (3 SCR, 3 Diode + FWD)
    // ---------------------------------------------------------
    } else if (name === 'three_phase_semi_converter') {
        const ox = 90, oy = 90;

        const va = createComponent('V_AC', { x: ox + 90, y: oy + 60 }, { x: ox, y: oy + 120 });
        va.props = { amplitude: 325, freq: 50, phase: 0 };
        components.push(va);

        const vb = createComponent('V_AC', { x: ox + 90, y: oy + 120 }, { x: ox, y: oy + 120 });
        vb.props = { amplitude: 325, freq: 50, phase: -120 };
        components.push(vb);

        const vc = createComponent('V_AC', { x: ox + 90, y: oy + 180 }, { x: ox, y: oy + 120 });
        vc.props = { amplitude: 325, freq: 50, phase: 120 };
        components.push(vc);

        components.push(createComponent('Wire', { x: ox + 90, y: oy + 60 }, { x: ox + 180, y: oy + 60 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 120 }, { x: ox + 240, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 180 }, { x: ox + 300, y: oy + 180 }));

        const t1 = createComponent('Thyristor', { x: ox + 180, y: oy + 60 }, { x: ox + 180, y: oy });
        t1.props = { delay_angle: 60, width: 60, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t1);

        const t3 = createComponent('Thyristor', { x: ox + 240, y: oy + 120 }, { x: ox + 240, y: oy });
        t3.props = { delay_angle: 180, width: 60, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t3);

        const t5 = createComponent('Thyristor', { x: ox + 300, y: oy + 180 }, { x: ox + 300, y: oy });
        t5.props = { delay_angle: 300, width: 60, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t5);

        components.push(createComponent('Diode', { x: ox + 180, y: oy + 240 }, { x: ox + 180, y: oy + 60 }));
        components.push(createComponent('Diode', { x: ox + 240, y: oy + 240 }, { x: ox + 240, y: oy + 120 }));
        components.push(createComponent('Diode', { x: ox + 300, y: oy + 240 }, { x: ox + 300, y: oy + 180 }));

        components.push(createComponent('Diode', { x: ox + 360, y: oy + 240 }, { x: ox + 360, y: oy }));

        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 240, y: oy }));
        components.push(createComponent('Wire', { x: ox + 240, y: oy }, { x: ox + 300, y: oy }));
        components.push(createComponent('Wire', { x: ox + 300, y: oy }, { x: ox + 360, y: oy }));
        components.push(createComponent('Wire', { x: ox + 360, y: oy }, { x: ox + 420, y: oy }));

        components.push(createComponent('Wire', { x: ox + 180, y: oy + 240 }, { x: ox + 240, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 240, y: oy + 240 }, { x: ox + 300, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 300, y: oy + 240 }, { x: ox + 360, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 360, y: oy + 240 }, { x: ox + 420, y: oy + 240 }));

        const l1 = createComponent('Inductor', { x: ox + 420, y: oy }, { x: ox + 420, y: oy + 120 });
        l1.props = { value: 30 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 420, y: oy + 120 }, { x: ox + 420, y: oy + 240 });
        r1.props = { value: 20 };
        components.push(r1);

        groundNodes.add(`N_${Math.round((ox + 420)/gridSize)}_${Math.round((oy + 240)/gridSize)}`);

    // ---------------------------------------------------------
    // 16. 1-Phase H-Bridge Inverter (4 MOSFETs)
    // ---------------------------------------------------------
    } else if (name === 'h_bridge_inverter') {
        const ox = 150, oy = 90;

        const vdc = createComponent('V_DC', { x: ox, y: oy }, { x: ox, y: oy + 240 });
        vdc.props = { value: 300 };
        components.push(vdc);

        const m1 = createComponent('MOSFET', { x: ox + 90, y: oy }, { x: ox + 90, y: oy + 120 });
        m1.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 0, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m1);

        const m4 = createComponent('MOSFET', { x: ox + 90, y: oy + 120 }, { x: ox + 90, y: oy + 240 });
        m4.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 180, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m4);

        const m3 = createComponent('MOSFET', { x: ox + 240, y: oy }, { x: ox + 240, y: oy + 120 });
        m3.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 180, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m3);

        const m2 = createComponent('MOSFET', { x: ox + 240, y: oy + 120 }, { x: ox + 240, y: oy + 240 });
        m2.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 0, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m2);

        components.push(createComponent('Wire', { x: ox, y: oy }, { x: ox + 90, y: oy }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy }, { x: ox + 240, y: oy }));
        components.push(createComponent('Wire', { x: ox, y: oy + 240 }, { x: ox + 90, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 240 }, { x: ox + 240, y: oy + 240 }));

        const l1 = createComponent('Inductor', { x: ox + 90, y: oy + 120 }, { x: ox + 165, y: oy + 120 });
        l1.props = { value: 15 };
        components.push(l1);

        const r1 = createComponent('Resistor', { x: ox + 165, y: oy + 120 }, { x: ox + 240, y: oy + 120 });
        r1.props = { value: 10 };
        components.push(r1);

        groundNodes.add(`N_${Math.round(ox/gridSize)}_${Math.round((oy + 240)/gridSize)}`);

    // ---------------------------------------------------------
    // 17. 3-Phase Inverter (6 MOSFETs)
    // ---------------------------------------------------------
    } else if (name === 'three_phase_inverter') {
        const ox = 120, oy = 90;

        const vdc = createComponent('V_DC', { x: ox, y: oy }, { x: ox, y: oy + 240 });
        vdc.props = { value: 300 };
        components.push(vdc);

        const m1 = createComponent('MOSFET', { x: ox + 90, y: oy }, { x: ox + 90, y: oy + 120 });
        m1.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 0, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m1);

        const m4 = createComponent('MOSFET', { x: ox + 90, y: oy + 120 }, { x: ox + 90, y: oy + 240 });
        m4.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 180, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m4);

        const m3 = createComponent('MOSFET', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 120 });
        m3.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 120, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m3);

        const m6 = createComponent('MOSFET', { x: ox + 180, y: oy + 120 }, { x: ox + 180, y: oy + 240 });
        m6.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 300, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m6);

        const m5 = createComponent('MOSFET', { x: ox + 270, y: oy }, { x: ox + 270, y: oy + 120 });
        m5.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 240, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m5);

        const m2 = createComponent('MOSFET', { x: ox + 270, y: oy + 120 }, { x: ox + 270, y: oy + 240 });
        m2.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 60, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(m2);

        components.push(createComponent('Wire', { x: ox, y: oy }, { x: ox + 90, y: oy }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy }, { x: ox + 180, y: oy }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy }, { x: ox + 270, y: oy }));

        components.push(createComponent('Wire', { x: ox, y: oy + 240 }, { x: ox + 90, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 90, y: oy + 240 }, { x: ox + 180, y: oy + 240 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 240 }, { x: ox + 270, y: oy + 240 }));

        components.push(createComponent('Wire', { x: ox + 90, y: oy + 120 }, { x: ox + 330, y: oy + 60 }));
        const ra = createComponent('Resistor', { x: ox + 330, y: oy + 60 }, { x: ox + 390, y: oy + 120 });
        ra.props = { value: 15 };
        components.push(ra);

        components.push(createComponent('Wire', { x: ox + 180, y: oy + 120 }, { x: ox + 330, y: oy + 120 }));
        const rb = createComponent('Resistor', { x: ox + 330, y: oy + 120 }, { x: ox + 390, y: oy + 120 });
        rb.props = { value: 15 };
        components.push(rb);

        components.push(createComponent('Wire', { x: ox + 270, y: oy + 120 }, { x: ox + 330, y: oy + 180 }));
        const rc = createComponent('Resistor', { x: ox + 330, y: oy + 180 }, { x: ox + 390, y: oy + 120 });
        rc.props = { value: 15 };
        components.push(rc);

        groundNodes.add(`N_${Math.round(ox/gridSize)}_${Math.round((oy + 240)/gridSize)}`);

    // ---------------------------------------------------------
    // 18. Inverter Half-Bridge Leg
    // ---------------------------------------------------------
    } else if (name === 'inverter_leg') {
        const ox = 180, oy = 90;
        components.push(createComponent('V_DC', { x: ox, y: oy }, { x: ox, y: oy + 180 }));
        components.find(c => c.type === 'V_DC').props = { value: 300 };

        const mTop = createComponent('MOSFET', { x: ox + 90, y: oy }, { x: ox + 90, y: oy + 90 });
        mTop.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 0, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(mTop);

        const mBot = createComponent('MOSFET', { x: ox + 90, y: oy + 90 }, { x: ox + 90, y: oy + 180 });
        mBot.props = { ctrl_type: 'pwm', freq: 50, duty: 50, phase: 180, ron: 0.005, roff: 1e6, body_diode: true };
        components.push(mBot);

        components.push(createComponent('Wire', { x: ox, y: oy }, { x: ox + 90, y: oy }));
        components.push(createComponent('Wire', { x: ox, y: oy + 180 }, { x: ox + 90, y: oy + 180 }));
        components.push(createComponent('Resistor', { x: ox + 90, y: oy + 90 }, { x: ox + 180, y: oy + 90 }));
        components.push(createComponent('Wire', { x: ox + 180, y: oy + 90 }, { x: ox + 180, y: oy + 180 }));

        groundNodes.add(`N_${Math.round(ox/gridSize)}_${Math.round((oy + 180)/gridSize)}`);
    }

    invalidateNets();
    runSimulation();
}

setTimeout(() => {
    loadPreset('full_bridge_thyristor');
}, 300);
