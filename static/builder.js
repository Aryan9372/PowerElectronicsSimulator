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

// Real-Time Playback & Animation State
let isPlaying = true;
let simPlaybackTime = 0.0; // Current time in seconds within AC cycle
let simCyclePeriod = 0.02; // 20 ms (50 Hz default, 1 cycle = 360 deg)
let simSpeed = 0.5; // Default playback speed
let lastFrameTime = performance.now();
let particlePhase = 0;

// Simulation Results Cache
let lastSimResults = null;
let activeChannels = new Set();
let autoSimDebounceTimer = null;
let isSimulating = false;

// Initialize Canvas Sizing
function resizeCanvas() {
    if (!container) return;
    width = container.clientWidth;
    height = container.clientHeight;
    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
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
// Real-Time Playback Controls & Frame Loop (60 FPS)
// -------------------------------------------------------------
function togglePlayPause() {
    isPlaying = !isPlaying;
    const btn = document.getElementById('playPauseBtn');
    const icon = document.getElementById('playIcon');
    const label = document.getElementById('playLabel');

    if (isPlaying) {
        btn.className = "px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1.5 shadow-md shadow-emerald-600/30 transition";
        icon.className = "fa-solid fa-pause";
        label.innerText = "Pause";
    } else {
        btn.className = "px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold flex items-center gap-1.5 border border-slate-700 transition";
        icon.className = "fa-solid fa-play";
        label.innerText = "Run Real-Time";
    }
}

function setSimSpeed(speed) {
    simSpeed = speed;
    document.querySelectorAll('.speed-btn').forEach(btn => {
        btn.className = "speed-btn px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300";
    });
    const active = document.getElementById(`speed-${speed}`);
    if (active) {
        active.className = "speed-btn px-2 py-0.5 rounded bg-cyan-900 border border-cyan-500 text-white font-bold";
    }
}

function onAngleSliderInput(angleDeg) {
    simPlaybackTime = (angleDeg / 360.0) * simCyclePeriod;
    updateAngleDisplay(angleDeg);
}

function stepAnimation(direction) {
    const stepSec = 0.0005; // 0.5 ms
    simPlaybackTime = (simPlaybackTime + direction * stepSec + simCyclePeriod) % simCyclePeriod;
    const deg = (simPlaybackTime / simCyclePeriod) * 360.0;
    updateAngleDisplay(deg);
}

function resetAnimation() {
    simPlaybackTime = 0.0;
    updateAngleDisplay(0.0);
}

function updateAngleDisplay(deg) {
    const slider = document.getElementById('angleSlider');
    const disp = document.getElementById('angleValueDisplay');
    if (slider && document.activeElement !== slider) slider.value = deg;
    if (disp) disp.innerText = `${deg.toFixed(1)}°`;
}

// Main 60 FPS Animation Loop
function animateLoop(timestamp) {
    const dt = (timestamp - lastFrameTime) / 1000.0;
    lastFrameTime = timestamp;

    if (isPlaying && simCyclePeriod > 0) {
        simPlaybackTime = (simPlaybackTime + dt * simSpeed) % simCyclePeriod;
        const currentAngleDeg = (simPlaybackTime / simCyclePeriod) * 360.0;
        updateAngleDisplay(currentAngleDeg);
    }

    particlePhase += dt * 80.0 * simSpeed;

    renderCanvas();
    requestAnimationFrame(animateLoop);
}
requestAnimationFrame(animateLoop);

// -------------------------------------------------------------
// Canvas Rendering Logic
// -------------------------------------------------------------
function renderCanvas() {
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, width, height);

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

    // 5. Junction Dots (diameter 8px)
    for (const [key, count] of Object.entries(pinCounts)) {
        if (count >= 3) {
            const [x, y] = key.split(',').map(Number);
            ctx.fillStyle = '#06b6d4';
            ctx.shadowColor = '#06b6d4';
            ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
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

    // Update Conduction Badge Status in HUD
    updateConductionStatusText(activeConductors);

    ctx.restore();
}

function getSimulationStepIndex() {
    if (!lastSimResults || !lastSimResults.time || lastSimResults.time.length === 0) return 0;
    const times = lastSimResults.time;
    const tMod = simPlaybackTime % times[times.length - 1];
    
    // Binary search or direct ratio
    const ratio = tMod / times[times.length - 1];
    const idx = Math.min(times.length - 1, Math.max(0, Math.floor(ratio * times.length)));
    return idx;
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
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 6;

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
            // Neon Green Glow Box around switch
            ctx.save();
            ctx.shadowColor = '#10b981';
            ctx.shadowBlur = 18;
            ctx.strokeStyle = '#22c55e';
            ctx.fillStyle = 'rgba(34, 197, 94, 0.2)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(mx - 24, my - 24, 48, 48, 8);
            ctx.fill();
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
    if (e.code === 'Space' && !spacePressed) {
        spacePressed = true;
        canvas.style.cursor = 'grab';
    }
    if ((e.key === 'r' || e.key === 'R') && selectedComp) {
        rotateSelected();
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedComp) {
        if (document.activeElement.tagName !== 'INPUT') {
            deleteSelected();
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
// Live Auto-Simulation (Debounced 60ms)
// -------------------------------------------------------------
function triggerAutoSimulate() {
    if (autoSimDebounceTimer) clearTimeout(autoSimDebounceTimer);
    autoSimDebounceTimer = setTimeout(() => {
        runSimulation(true);
    }, 60);
}

// -------------------------------------------------------------
// Simulation Engine Execution & API Routing
// -------------------------------------------------------------
async function runSimulation(isBackgroundAuto = false) {
    if (components.length === 0) return;
    if (groundNodes.size === 0) return;
    if (isSimulating) return;

    isSimulating = true;
    const runBtn = document.getElementById('runBtn');
    if (!isBackgroundAuto && runBtn) {
        runBtn.innerHTML = '<i class="fa-solid fa-spinner animate-spin"></i> Solving...';
        runBtn.disabled = true;
    }

    const { netMap } = computeElectricalNets();

    const circuitPayload = {
        simulation: { t_end: 0.04, dt: 2e-5 },
        components: [],
        control: {}
    };

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

        // Auto-configure channels if empty
        if (activeChannels.size === 0) {
            const rComp = components.find(c => c.type === 'Resistor');
            if (rComp) activeChannels.add(`I(${rComp.id})`);
            const acComp = components.find(c => c.type === 'V_AC');
            if (acComp) activeChannels.add(`V(${netMap[`N_${Math.round(acComp.p1.x/gridSize)}_${Math.round(acComp.p1.y/gridSize)}`]})`);
            Object.keys(data.nodes).forEach(n => {
                if (n !== 'GND' && n !== 'gnd' && activeChannels.size < 3) activeChannels.add(`V(${n})`);
            });
        }

        buildChannelToggles();
        updatePlot();
        updateStatsDashboard(data);

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

// Optimized Plotly update with downsampling for maximum smoothness
function updatePlot() {
    if (!lastSimResults) return;
    const { time, nodes, branch_i, switches } = lastSimResults;

    // Downsample if more than 600 points to keep UI at 60 FPS
    const step = Math.max(1, Math.floor(time.length / 600));
    const downsampledTime = [];
    for (let i = 0; i < time.length; i += step) {
        downsampledTime.push(time[i] * 1000.0);
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
                const yVals = [];
                for (let i = 0; i < time.length; i += step) yVals.push(nodes[node][i]);
                traces.push({
                    x: downsampledTime,
                    y: yVals,
                    mode: 'lines',
                    name: key,
                    line: { color: color, width: 2 }
                });
            }
        } else if (key.startsWith('I(')) {
            const cid = key.slice(2, -1);
            if (branch_i[cid]) {
                const yVals = [];
                for (let i = 0; i < time.length; i += step) yVals.push(branch_i[cid][i]);
                traces.push({
                    x: downsampledTime,
                    y: yVals,
                    mode: 'lines',
                    name: key,
                    yaxis: 'y2',
                    line: { color: color, width: 2, dash: 'dot' }
                });
            }
        } else if (key.startsWith('State(')) {
            const cid = key.slice(6, -1);
            if (switches[cid]) {
                const yVals = [];
                for (let i = 0; i < time.length; i += step) yVals.push(switches[cid][i]);
                traces.push({
                    x: downsampledTime,
                    y: yVals,
                    mode: 'lines',
                    name: key,
                    yaxis: 'y3',
                    line: { color: color, width: 1.5, shape: 'hv' }
                });
            }
        }
    });

    const layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: '#070a13',
        font: { color: '#94a3b8', size: 10 },
        margin: { l: 45, r: 45, t: 15, b: 35 },
        hovermode: 'x unified',
        xaxis: {
            title: 'Time (ms)',
            gridcolor: '#1e293b',
            zerolinecolor: '#334155'
        },
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
        legend: {
            orientation: 'h',
            y: 1.15,
            x: 0,
            font: { size: 10 }
        }
    };

    Plotly.react('plot', traces, layout, { responsive: true, displayModeBar: false });
}

function updateStatsDashboard(data) {
    if (!data.stats) return;

    const rComp = components.find(c => c.type === 'Resistor');
    let avgV = 0, rmsV = 0, avgI = 0, rmsI = 0, power = 0, rf = 0;

    if (rComp) {
        const iStats = data.stats[`I(${rComp.id})`];
        if (iStats) {
            avgI = iStats.avg;
            rmsI = iStats.rms;
            power = iStats.p_avg;
        }
    }

    const nodeKeys = Object.keys(data.nodes).filter(n => n !== 'GND' && n !== 'gnd');
    if (nodeKeys.length > 0) {
        const vStats = data.stats[`V(${nodeKeys[0]})`];
        if (vStats) {
            avgV = vStats.avg;
            rmsV = vStats.rms;
            if (avgV !== 0) {
                const ff = rmsV / Math.abs(avgV);
                rf = Math.sqrt(Math.max(0, ff**2 - 1));
            }
        }
    }

    document.getElementById('statAvgV').innerText = `${avgV.toFixed(1)} V`;
    document.getElementById('statRmsV').innerText = `${rmsV.toFixed(1)} V`;
    document.getElementById('statAvgI').innerText = `${avgI.toFixed(2)} A`;
    document.getElementById('statRmsI').innerText = `${rmsI.toFixed(2)} A`;
    document.getElementById('statPower').innerText = `${Math.abs(power).toFixed(1)} W`;
    document.getElementById('statRF').innerText = `${rf.toFixed(3)}`;
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

    if (name === 'full_bridge_thyristor') {
        // Matches user reference screenshot exactly
        const ox = 150, oy = 90;

        components.push(createComponent('V_AC', { x: ox, y: oy + 90 }, { x: ox, y: oy + 150 }));
        components.find(c => c.type === 'V_AC').props = { amplitude: 325, freq: 50, phase: 0 };

        const t1 = createComponent('Thyristor', { x: ox + 90, y: oy + 90 }, { x: ox + 90, y: oy });
        t1.props = { delay_angle: 45, width: 20, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t1);

        const t4 = createComponent('Thyristor', { x: ox + 90, y: oy + 240 }, { x: ox + 90, y: oy + 90 });
        t4.props = { delay_angle: 225, width: 20, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t4);

        const t3 = createComponent('Thyristor', { x: ox + 180, y: oy + 150 }, { x: ox + 180, y: oy });
        t3.props = { delay_angle: 225, width: 20, freq: 50, ron: 0.001, roff: 1e6 };
        components.push(t3);

        const t2 = createComponent('Thyristor', { x: ox + 180, y: oy + 240 }, { x: ox + 180, y: oy + 150 });
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

    } else if (name === 'mosfet_buck') {
        const ox = 150, oy = 120;

        const vdc = createComponent('V_DC', { x: ox, y: oy + 120 }, { x: ox, y: oy });
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

    } else if (name === 'half_wave') {
        const ox = 180, oy = 120;
        components.push(createComponent('V_AC', { x: ox, y: oy + 120 }, { x: ox, y: oy }));
        components.push(createComponent('Diode', { x: ox, y: oy }, { x: ox + 90, y: oy }));
        components.push(createComponent('Inductor', { x: ox + 90, y: oy }, { x: ox + 180, y: oy }));
        components.push(createComponent('Resistor', { x: ox + 180, y: oy }, { x: ox + 180, y: oy + 120 }));
        components.push(createComponent('Wire', { x: ox, y: oy + 120 }, { x: ox + 180, y: oy + 120 }));
        groundNodes.add(`N_${Math.round(ox/gridSize)}_${Math.round((oy + 120)/gridSize)}`);

    } else if (name === 'inverter_leg') {
        const ox = 180, oy = 90;
        components.push(createComponent('V_DC', { x: ox, y: oy + 180 }, { x: ox, y: oy }));
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
