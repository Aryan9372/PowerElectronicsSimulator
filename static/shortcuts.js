/**
 * PowerSim PRO - Oscilloscope & Transient View Modular Keyboard Shortcuts System
 * 
 * Modular keyboard shortcuts extension for oscilloscope and transient analysis.
 * Integrates cleanly with builder.js without direct modification.
 * 
 * Shortcuts:
 *   [           : Decrease transient duration (200ms -> 100ms -> 50ms -> 20ms)
 *   ]           : Increase transient duration (20ms -> 50ms -> 100ms -> 200ms -> All)
 *   1, 2, 3, 4  : Direct jump to 20ms, 50ms, 100ms, 200ms
 *   0           : Reset to full transient timeline (All)
 *   ArrowLeft   : Step scrubbed time -1 ms (-5 ms with Shift) when scrubbed
 *   ArrowRight  : Step scrubbed time +1 ms (+5 ms with Shift) when scrubbed
 *   Space       : Toggle pause/resume sweep (trigger resumeSweep() or scrub at current angle)
 *   ?           : Show/hide keyboard shortcuts cheat sheet modal
 *   Esc         : Close shortcuts modal
 */

(function () {
    'use strict';

    // Module internal state
    let isInitialized = false;
    let cachedSimResults = null;
    let trackedScrubbedMs = null;
    let trackedDurationMs = null; // null represents 'All'

    /**
     * Checks if user is typing inside an input, textarea, or select field.
     */
    function isEditingInput(target) {
        const el = target || document.activeElement;
        if (!el) return false;
        const tag = (el.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        return false;
    }

    /**
     * Checks if oscilloscope is currently in scrubbed inspection mode.
     */
    function isScrubbed() {
        if (trackedScrubbedMs !== null) return true;
        const btnResume = document.getElementById('btnResumeSweep');
        if (btnResume && !btnResume.classList.contains('hidden')) return true;
        const ribbon = document.getElementById('ribbonScrubIndicator');
        if (ribbon && !ribbon.classList.contains('hidden')) return true;
        return false;
    }

    /**
     * Gets current scrubbed time in ms.
     */
    function getCurrentScrubbedTimeMs() {
        if (trackedScrubbedMs !== null) return trackedScrubbedMs;

        const ribbon = document.getElementById('ribbonScrubText');
        if (ribbon && ribbon.innerText) {
            const m = ribbon.innerText.match(/([\d.]+)\s*ms/i);
            if (m) return parseFloat(m[1]);
        }
        return 0;
    }

    /**
     * Gets total simulation duration in ms.
     */
    function getTotalSimTimeMs() {
        if (cachedSimResults && cachedSimResults.time && cachedSimResults.time.length > 0) {
            return cachedSimResults.time[cachedSimResults.time.length - 1] * 1000.0;
        }
        const plotEl = document.getElementById('plot');
        if (plotEl && plotEl.data && plotEl.data[0] && Array.isArray(plotEl.data[0].x) && plotEl.data[0].x.length > 0) {
            const xArr = plotEl.data[0].x;
            return xArr[xArr.length - 1];
        }
        const inp = document.getElementById('transientDurationInput');
        if (inp && inp.placeholder) {
            const val = parseFloat(inp.placeholder);
            if (!isNaN(val) && val > 0) return val;
        }
        return 200.0;
    }

    /**
     * Gets the currently active transient duration setting in ms (or null for 'All').
     */
    function getCurrentTransientDuration() {
        if (trackedDurationMs !== undefined && trackedDurationMs !== null) {
            return trackedDurationMs;
        }
        const inp = document.getElementById('transientDurationInput');
        if (inp && inp.value && !isNaN(parseFloat(inp.value))) {
            return parseFloat(inp.value);
        }
        const activeBtn = document.querySelector('.transient-preset-btn.active');
        if (activeBtn) {
            if (activeBtn.id === 'tbtn-20' || activeBtn.id === 'btnTransient20') return 20;
            if (activeBtn.id === 'tbtn-50' || activeBtn.id === 'btnTransient50') return 50;
            if (activeBtn.id === 'tbtn-100' || activeBtn.id === 'btnTransient100') return 100;
            if (activeBtn.id === 'tbtn-200' || activeBtn.id === 'btnTransient200') return 200;
            if (activeBtn.id === 'tbtn-all' || activeBtn.id === 'btnTransientAll') return null;
        }
        return null;
    }

    /**
     * Ensures UI is in Transient View mode so duration changes are immediately visible.
     */
    function ensureTransientMode() {
        if (typeof window.setGraphViewMode === 'function') {
            const btnSteady = document.getElementById('btnViewSteady');
            if (btnSteady && (btnSteady.classList.contains('bg-cyan-600/30') || btnSteady.classList.contains('border-cyan-500/50'))) {
                window.setGraphViewMode('transient');
            }
        }
    }

    /**
     * Decreases transient duration ladder: 200ms -> 100ms -> 50ms -> 20ms.
     */
    function decreaseTransientDuration() {
        ensureTransientMode();
        const curr = getCurrentTransientDuration();
        let target;
        if (curr === null || curr > 200) {
            target = 200;
        } else if (curr > 100) {
            target = 100;
        } else if (curr > 50) {
            target = 50;
        } else if (curr > 20) {
            target = 20;
        } else {
            target = 20; // Clamped at minimum preset
        }
        if (typeof window.setTransientViewDuration === 'function') {
            window.setTransientViewDuration(target);
        }
    }

    /**
     * Increases transient duration ladder: 20ms -> 50ms -> 100ms -> 200ms -> All.
     */
    function increaseTransientDuration() {
        ensureTransientMode();
        const curr = getCurrentTransientDuration();
        let target;
        if (curr !== null && curr <= 20) {
            target = 50;
        } else if (curr !== null && curr <= 50) {
            target = 100;
        } else if (curr !== null && curr <= 100) {
            target = 200;
        } else {
            target = 'all'; // Clamped at Full simulation timeline
        }
        if (typeof window.setTransientViewDuration === 'function') {
            window.setTransientViewDuration(target);
        }
    }

    /**
     * Jumps directly to a specific duration preset.
     */
    function setPresetDuration(val) {
        ensureTransientMode();
        if (typeof window.setTransientViewDuration === 'function') {
            window.setTransientViewDuration(val);
        }
    }

    /**
     * Steps scrubbed time backward or forward by 1 ms (or 5 ms if Shift held).
     */
    function stepScrubbedTime(direction, isFast) {
        if (!isScrubbed()) return;
        const stepMs = isFast ? 5.0 : 1.0;
        const currentMs = getCurrentScrubbedTimeMs();
        const maxMs = getTotalSimTimeMs();
        const nextMs = Math.max(0, Math.min(maxMs, Math.round((currentMs + direction * stepMs) * 100) / 100));

        if (typeof window.onPlotScrub === 'function') {
            window.onPlotScrub(nextMs);
        }
    }

    /**
     * Toggles pause / resume sweep:
     * - If currently scrubbed, resumes continuous sweep loop.
     * - If currently running, scrubs at the current cycle angle / timestamp.
     */
    function togglePauseResumeSweep() {
        if (isScrubbed()) {
            if (typeof window.resumeSweep === 'function') {
                window.resumeSweep();
            }
        } else {
            // Determine timestamp at current sweep position
            const totalMs = getTotalSimTimeMs();
            const btnSteady = document.getElementById('btnViewSteady');
            const isSteady = btnSteady && (btnSteady.classList.contains('bg-cyan-600/30') || btnSteady.classList.contains('border-cyan-500/50'));

            // Read current angle (0..360 deg)
            let angleDeg = 0;
            const angleDisp = document.getElementById('angleValueDisplay');
            if (angleDisp && angleDisp.innerText) {
                const match = angleDisp.innerText.match(/([\d.]+)/);
                if (match) angleDeg = parseFloat(match[1]);
            }
            if (isNaN(angleDeg) || angleDeg === 0) {
                const slider = document.getElementById('angleSlider');
                if (slider) angleDeg = parseFloat(slider.value) || 0;
            }
            const ratio = Math.max(0, Math.min(1, angleDeg / 360.0));

            let targetMs = 0;
            if (isSteady) {
                let t_start_ms = 0;
                let t_end_ms = totalMs;
                if (cachedSimResults && cachedSimResults.steady_window && typeof cachedSimResults.steady_window.t_start === 'number') {
                    t_start_ms = cachedSimResults.steady_window.t_start * 1000.0;
                    t_end_ms = cachedSimResults.steady_window.t_end * 1000.0;
                } else {
                    t_start_ms = Math.max(0, totalMs - 20.0);
                    t_end_ms = totalMs;
                }
                targetMs = t_start_ms + ratio * Math.max(1e-4, t_end_ms - t_start_ms);
            } else {
                const durationMs = getCurrentTransientDuration();
                const viewEndMs = (durationMs !== null) ? Math.min(totalMs, Math.max(0.1, durationMs)) : totalMs;
                targetMs = ratio * viewEndMs;
            }

            if (typeof window.onPlotScrub === 'function') {
                window.onPlotScrub(Math.round(targetMs * 100) / 100);
            }
        }
    }

    /**
     * Toggles visibility of keyboard shortcuts cheat sheet modal.
     */
    function toggleShortcutsModal(forceState) {
        const modal = document.getElementById('shortcutsModal');
        if (!modal) return;
        const shouldShow = (forceState !== undefined) ? !!forceState : modal.classList.contains('hidden');
        if (shouldShow) {
            modal.classList.remove('hidden');
        } else {
            modal.classList.add('hidden');
        }
    }

    /**
     * Central Keyboard Event Dispatcher
     */
    function handleKeyDown(e) {
        // Ignore any keystrokes when user is focused inside input, textarea, or select
        if (isEditingInput(e.target)) {
            return;
        }

        // Close modal on Escape
        if (e.key === 'Escape') {
            const modal = document.getElementById('shortcutsModal');
            if (modal && !modal.classList.contains('hidden')) {
                e.preventDefault();
                toggleShortcutsModal(false);
                return;
            }
        }

        // Toggle shortcuts help on '?' (Shift + /)
        if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            toggleShortcutsModal();
            return;
        }

        // Bracket keys: Transient duration decrease '[' / increase ']'
        if ((e.key === '[' || e.code === 'BracketLeft') && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            decreaseTransientDuration();
            return;
        }

        if ((e.key === ']' || e.code === 'BracketRight') && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            increaseTransientDuration();
            return;
        }

        // Space: Toggle pause / resume sweep
        if ((e.code === 'Space' || e.key === ' ') && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            togglePauseResumeSweep();
            return;
        }

        // Arrow Left / Arrow Right: Step scrubbed time (1 ms standard, 5 ms with Shift)
        if (e.key === 'ArrowLeft' && !e.ctrlKey && !e.altKey && !e.metaKey) {
            if (isScrubbed()) {
                e.preventDefault();
                stepScrubbedTime(-1, e.shiftKey);
                return;
            }
        }

        if (e.key === 'ArrowRight' && !e.ctrlKey && !e.altKey && !e.metaKey) {
            if (isScrubbed()) {
                e.preventDefault();
                stepScrubbedTime(1, e.shiftKey);
                return;
            }
        }

        // Number keys 1, 2, 3, 4, 0 (Top row and numpad)
        if (!e.ctrlKey && !e.altKey && !e.metaKey) {
            if (e.key === '1' || e.code === 'Digit1' || e.code === 'Numpad1') {
                e.preventDefault();
                setPresetDuration(20);
                return;
            }
            if (e.key === '2' || e.code === 'Digit2' || e.code === 'Numpad2') {
                e.preventDefault();
                setPresetDuration(50);
                return;
            }
            if (e.key === '3' || e.code === 'Digit3' || e.code === 'Numpad3') {
                e.preventDefault();
                setPresetDuration(100);
                return;
            }
            if (e.key === '4' || e.code === 'Digit4' || e.code === 'Numpad4') {
                e.preventDefault();
                setPresetDuration(200);
                return;
            }
            if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') {
                e.preventDefault();
                setPresetDuration('all');
                return;
            }
        }
    }

    /**
     * Intercept and hook builder.js functions seamlessly without modifying builder.js
     */
    function hookBuilderFunctions() {
        if (window.updateStatsDashboard && !window.updateStatsDashboard._hookedByShortcuts) {
            const origStats = window.updateStatsDashboard;
            window.updateStatsDashboard = function (data) {
                if (data) cachedSimResults = data;
                return origStats.apply(this, arguments);
            };
            window.updateStatsDashboard._hookedByShortcuts = true;
        }

        if (window.onPlotScrub && !window.onPlotScrub._hookedByShortcuts) {
            const origScrub = window.onPlotScrub;
            window.onPlotScrub = function (timeMs) {
                trackedScrubbedMs = Math.max(0, timeMs);
                return origScrub.apply(this, arguments);
            };
            window.onPlotScrub._hookedByShortcuts = true;
        }

        if (window.resumeSweep && !window.resumeSweep._hookedByShortcuts) {
            const origResume = window.resumeSweep;
            window.resumeSweep = function () {
                trackedScrubbedMs = null;
                return origResume.apply(this, arguments);
            };
            window.resumeSweep._hookedByShortcuts = true;
        }

        if (window.setTransientViewDuration && !window.setTransientViewDuration._hookedByShortcuts) {
            const origDuration = window.setTransientViewDuration;
            window.setTransientViewDuration = function (val) {
                if (val === 'all' || val === 'All' || val === null || val === undefined || val === '') {
                    trackedDurationMs = null;
                } else {
                    const n = parseFloat(val);
                    if (!isNaN(n) && n > 0) trackedDurationMs = n;
                }
                return origDuration.apply(this, arguments);
            };
            window.setTransientViewDuration._hookedByShortcuts = true;
        }
    }

    /**
     * Initialize oscilloscope keyboard shortcuts system.
     * Idempotent: safe to call multiple times.
     */
    function initOscilloscopeShortcuts() {
        hookBuilderFunctions();

        if (!isInitialized) {
            window.addEventListener('keydown', handleKeyDown);
            isInitialized = true;
        }
    }

    // Expose public API
    window.initOscilloscopeShortcuts = initOscilloscopeShortcuts;
    window.toggleShortcutsModal = toggleShortcutsModal;

    // Self-initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initOscilloscopeShortcuts);
    } else {
        initOscilloscopeShortcuts();
    }
})();
