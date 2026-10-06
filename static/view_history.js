// static/view_history.js
// Transient zoom history navigation (Undo Zoom / Reset Zoom) for PowerSim PRO

const viewHistoryStack = [];

/**
 * Pushes a zoom time-range [startMs, endMs] to the history stack.
 * @param {number|string|object} startMs - Start time in ms (or object { startMs, endMs })
 * @param {number|string} [endMs] - End time in ms (or 'all')
 */
function pushViewHistory(startMs, endMs) {
    if (startMs === undefined && endMs === undefined) return;

    let s = startMs;
    let e = endMs;

    if (e === undefined) {
        if (typeof s === 'object' && s !== null) {
            e = s.endMs;
            s = s.startMs;
        } else {
            e = s;
            s = 0;
        }
    }

    const entry = {
        startMs: (s === 'all' || s === 'All') ? 0 : Number(s),
        endMs: (e === 'all' || e === 'All') ? 'all' : Number(e)
    };

    // Avoid pushing duplicate consecutive entries
    if (viewHistoryStack.length > 0) {
        const top = viewHistoryStack[viewHistoryStack.length - 1];
        if (top.startMs === entry.startMs && top.endMs === entry.endMs) {
            return entry;
        }
    }

    viewHistoryStack.push(entry);
    return entry;
}

/**
 * Restores the previous zoom range from the history stack if available.
 * @returns {object|null} The restored range entry or null if stack was empty.
 */
function popViewHistory() {
    if (viewHistoryStack.length === 0) {
        return null;
    }

    const prev = viewHistoryStack.pop();
    if (!prev) return null;

    if (prev.endMs === 'all' || prev.endMs === 'All') {
        if (typeof window !== 'undefined' && typeof window.setTransientViewDuration === 'function') {
            window.setTransientViewDuration('all');
        }
    } else {
        const s = parseFloat(prev.startMs) || 0;
        const e = parseFloat(prev.endMs);
        if (!isNaN(e) && e > s) {
            if (s === 0 && typeof window !== 'undefined' && typeof window.setTransientViewDuration === 'function') {
                window.setTransientViewDuration(e);
            } else if (typeof window !== 'undefined' && window.Plotly && typeof document !== 'undefined') {
                const plotEl = document.getElementById('plot');
                if (plotEl && plotEl.data && plotEl.data.length > 0) {
                    window.Plotly.relayout(plotEl, {
                        'xaxis.range[0]': s,
                        'xaxis.range[1]': e,
                        'xaxis.autorange': false
                    });
                } else if (typeof window.setTransientViewDuration === 'function') {
                    window.setTransientViewDuration(e);
                }
            } else if (typeof window !== 'undefined' && typeof window.setTransientViewDuration === 'function') {
                window.setTransientViewDuration(e);
            }
        }
    }

    return prev;
}

/**
 * Resets the transient view to the full simulation timeline and clears the history stack.
 */
function resetViewToFull() {
    viewHistoryStack.length = 0;
    if (typeof window !== 'undefined' && typeof window.setTransientViewDuration === 'function') {
        window.setTransientViewDuration('all');
    }
}

// Attach functions to window.ViewHistory
if (typeof window !== 'undefined') {
    window.ViewHistory = {
        pushViewHistory,
        popViewHistory,
        resetViewToFull
    };
    window.ViewHistory.viewHistoryStack = viewHistoryStack;
    window.viewHistoryStack = viewHistoryStack;
}

// Support CommonJS export for Node.js unit testing & verification
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        viewHistoryStack,
        pushViewHistory,
        popViewHistory,
        resetViewToFull
    };
}
