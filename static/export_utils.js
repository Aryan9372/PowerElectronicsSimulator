/**
 * PowerSim PRO - Transient Waveform CSV & Data Exporter
 * static/export_utils.js
 *
 * Implements client-side high-fidelity CSV data export for visible transient waveforms.
 * Features:
 * - Checks window.lastSimResults for solved simulation data.
 * - Extracts active viewing time window [view_t0, view_t1] from Plotly layout or transient duration state.
 * - Gathers time (s), time (ms), and values for all visible/active channels (node voltages and branch currents).
 * - Formats clean CSV header: "Time (s), Time (ms), V(node1), I(comp1), ..."
 * - Dispatches browser download via HTML5 Blob API: "powersim_transient_data.csv".
 */

(function () {
    // Ensure window.lastSimResults getter links to global lastSimResults if in browser scope
    try {
        if (typeof window !== 'undefined' && !('lastSimResults' in window)) {
            Object.defineProperty(window, 'lastSimResults', {
                get() {
                    try {
                        if (typeof lastSimResults !== 'undefined') return lastSimResults;
                    } catch (e) {}
                    return window._lastSimResults || null;
                },
                set(val) {
                    window._lastSimResults = val;
                },
                configurable: true,
                enumerable: true
            });
        }
    } catch (e) {
        // Silently ignore in non-browser or strict contexts
    }

    /**
     * Formats a floating point number cleanly for CSV serialization.
     * Prevents IEEE-754 binary floating point precision artifacts.
     * Uses scientific notation for very small/large values to preserve fidelity.
     * 
     * @param {number} val - Number to format
     * @param {number} decimals - Precision decimal places
     * @returns {string} Formatted number string
     */
    function formatNumber(val, decimals = 6) {
        if (val == null || isNaN(val)) return '0';
        if (!isFinite(val)) return val > 0 ? 'Infinity' : '-Infinity';
        const num = Number(val);
        const abs = Math.abs(num);
        if (abs === 0) return '0';
        if (abs < 1e-5 || abs >= 1e7) {
            return num.toExponential(decimals);
        }
        return Number(num.toFixed(decimals)).toString();
    }

    /**
     * Exports visible transient waveforms to a clean CSV file.
     */
    function exportVisibleWaveformCSV() {
        // 1. Check window.lastSimResults (or lastSimResults in scope)
        let simResults = null;
        if (typeof window !== 'undefined' && window.lastSimResults) {
            simResults = window.lastSimResults;
        } else if (typeof lastSimResults !== 'undefined' && lastSimResults) {
            simResults = lastSimResults;
        }

        if (!simResults || !simResults.time || !Array.isArray(simResults.time) || simResults.time.length === 0) {
            console.warn('[PowerSim Export] No transient simulation results available to export.');
            if (typeof alert === 'function') {
                alert('No transient waveform data found. Please run a simulation first before exporting.');
            }
            return;
        }

        const times = simResults.time;
        const totalSimTimeSec = times[times.length - 1];

        // 2. Identify the active viewing time window [view_t0, view_t1]
        let view_t0 = 0.0;
        let view_t1 = totalSimTimeSec;

        const isSteady = (typeof graphViewMode !== 'undefined' && graphViewMode === 'steady');
        if (isSteady && simResults.steady_window && typeof simResults.steady_window.t_start === 'number') {
            view_t0 = simResults.steady_window.t_start;
            view_t1 = simResults.steady_window.t_end;
        } else {
            let userRangeFound = false;

            // Check Plotly layout's current x-axis range (interactive rangeslider, zoom, pan)
            const plotEl = (typeof document !== 'undefined') ? document.getElementById('plot') : null;
            if (plotEl && plotEl.layout && plotEl.layout.xaxis && Array.isArray(plotEl.layout.xaxis.range)) {
                const r0 = Number(plotEl.layout.xaxis.range[0]);
                const r1 = Number(plotEl.layout.xaxis.range[1]);
                if (!isNaN(r0) && !isNaN(r1) && r1 > r0) {
                    view_t0 = r0 / 1000.0;
                    view_t1 = r1 / 1000.0;
                    userRangeFound = true;
                }
            }

            // Check transientView duration state variables if Plotly range is not set
            if (!userRangeFound) {
                const hasStart = (typeof transientViewStartMs !== 'undefined' && transientViewStartMs !== null && !isNaN(transientViewStartMs));
                const hasEnd = (typeof transientViewEndMs !== 'undefined' && transientViewEndMs !== null && !isNaN(transientViewEndMs));
                const hasDur = (typeof transientViewDurationMs !== 'undefined' && transientViewDurationMs !== null && !isNaN(transientViewDurationMs));

                if (hasStart && hasEnd) {
                    view_t0 = Math.max(0, transientViewStartMs) / 1000.0;
                    view_t1 = transientViewEndMs / 1000.0;
                    userRangeFound = true;
                } else if (hasDur) {
                    const s0 = hasStart ? Math.max(0, transientViewStartMs) : 0;
                    view_t0 = s0 / 1000.0;
                    view_t1 = (s0 + transientViewDurationMs) / 1000.0;
                    userRangeFound = true;
                }
            }

            // Fallback: full timeline if none specified
            if (!userRangeFound) {
                view_t0 = 0.0;
                view_t1 = totalSimTimeSec;
            }
        }

        // Clamp bounds strictly within solved simulation range
        view_t0 = Math.max(0.0, Math.min(view_t0, totalSimTimeSec));
        view_t1 = Math.max(view_t0, Math.min(view_t1, totalSimTimeSec));

        // If window collapsed to a single point, expand to full timeline
        if (Math.abs(view_t1 - view_t0) < 1e-9) {
            view_t0 = 0.0;
            view_t1 = totalSimTimeSec;
        }

        // 3. Gather all visible/active channels (node voltages and branch currents)
        const channelsToExport = [];
        const activeSet = (typeof window !== 'undefined' && window.activeChannels instanceof Set)
            ? window.activeChannels
            : ((typeof activeChannels !== 'undefined' && activeChannels instanceof Set) ? activeChannels : null);

        if (activeSet && activeSet.size > 0) {
            activeSet.forEach(ch => {
                if (ch.startsWith('V(')) {
                    const node = ch.slice(2, -1);
                    if (simResults.nodes && Array.isArray(simResults.nodes[node])) {
                        channelsToExport.push({ name: ch, data: simResults.nodes[node] });
                    }
                } else if (ch.startsWith('I(')) {
                    const cid = ch.slice(2, -1);
                    if (simResults.branch_i && Array.isArray(simResults.branch_i[cid])) {
                        channelsToExport.push({ name: ch, data: simResults.branch_i[cid] });
                    }
                } else if (ch.startsWith('State(')) {
                    const cid = ch.slice(6, -1);
                    if (simResults.switches && Array.isArray(simResults.switches[cid])) {
                        channelsToExport.push({ name: ch, data: simResults.switches[cid] });
                    }
                }
            });
        }

        // Fallback: check Plotly active traces
        if (channelsToExport.length === 0) {
            const plotEl = (typeof document !== 'undefined') ? document.getElementById('plot') : null;
            if (plotEl && Array.isArray(plotEl.data)) {
                plotEl.data.forEach(tr => {
                    if (tr && tr.name && tr.visible !== 'legendonly' && tr.visible !== false) {
                        if (tr.name.startsWith('V(')) {
                            const node = tr.name.slice(2, -1);
                            if (simResults.nodes && Array.isArray(simResults.nodes[node])) {
                                channelsToExport.push({ name: tr.name, data: simResults.nodes[node] });
                            }
                        } else if (tr.name.startsWith('I(')) {
                            const cid = tr.name.slice(2, -1);
                            if (simResults.branch_i && Array.isArray(simResults.branch_i[cid])) {
                                channelsToExport.push({ name: tr.name, data: simResults.branch_i[cid] });
                            }
                        }
                    }
                });
            }
        }

        // Fallback: gather all available node voltages and branch currents
        if (channelsToExport.length === 0) {
            if (simResults.nodes) {
                Object.keys(simResults.nodes).forEach(n => {
                    if (n !== 'GND' && n !== 'gnd' && n !== '0' && Array.isArray(simResults.nodes[n])) {
                        channelsToExport.push({ name: `V(${n})`, data: simResults.nodes[n] });
                    }
                });
            }
            if (simResults.branch_i) {
                Object.keys(simResults.branch_i).forEach(cid => {
                    if (Array.isArray(simResults.branch_i[cid])) {
                        channelsToExport.push({ name: `I(${cid})`, data: simResults.branch_i[cid] });
                    }
                });
            }
        }

        if (channelsToExport.length === 0) {
            console.warn('[PowerSim Export] No active or visible waveform channels to export.');
            if (typeof alert === 'function') {
                alert('No visible waveform channels to export. Please toggle at least one channel.');
            }
            return;
        }

        // 4. Gather data points within the active viewing window [view_t0, view_t1]
        const eps = 1e-9;
        const indices = [];
        for (let i = 0; i < times.length; i++) {
            const t = times[i];
            if (t >= view_t0 - eps && t <= view_t1 + eps) {
                indices.push(i);
            }
        }

        if (indices.length === 0) {
            for (let i = 0; i < times.length; i++) {
                indices.push(i);
            }
        }

        // 5. Format clean CSV header: "Time (s), Time (ms), V(node1), I(comp1), ..."
        const headerCols = ['Time (s)', 'Time (ms)'];
        channelsToExport.forEach(ch => headerCols.push(ch.name));
        const headerLine = headerCols.join(', ');

        const rows = [headerLine];
        for (let k = 0; k < indices.length; k++) {
            const idx = indices[k];
            const tSec = times[idx];
            const tMs = tSec * 1000.0;

            const rowCols = [
                formatNumber(tSec, 8),
                formatNumber(tMs, 4)
            ];

            for (let c = 0; c < channelsToExport.length; c++) {
                const arr = channelsToExport[c].data;
                const val = (arr && arr.length > idx) ? arr[idx] : 0;
                rowCols.push(formatNumber(val, 6));
            }

            rows.push(rowCols.join(', '));
        }

        const csvContent = rows.join('\r\n');

        // 6. Create Blob with 'text/csv;charset=utf-8;' and trigger download 'powersim_transient_data.csv'
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', 'powersim_transient_data.csv');
        link.style.display = 'none';

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);

        console.log(`[PowerSim Export] Exported ${indices.length} points (${channelsToExport.length} channels) in window [${(view_t0*1000).toFixed(2)} ms, ${(view_t1*1000).toFixed(2)} ms] to powersim_transient_data.csv`);
    }

    // Expose window.exportVisibleWaveformCSV
    if (typeof window !== 'undefined') {
        window.exportVisibleWaveformCSV = exportVisibleWaveformCSV;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { exportVisibleWaveformCSV, formatNumber };
    }
})();
