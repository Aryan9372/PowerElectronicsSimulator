const alphaSlider = document.getElementById('alphaSlider');
const alphaValue = document.getElementById('alphaValue');
const rInput = document.getElementById('rInput');
const lInput = document.getElementById('lInput');
const vInput = document.getElementById('vInput');

const avgV = document.getElementById('avgV');
const avgI = document.getElementById('avgI');
const avgP = document.getElementById('avgP');

let fetchTimeout = null;

function updateSimulation() {
    const alpha = parseFloat(alphaSlider.value);
    const r_val = parseFloat(rInput.value);
    const l_val = parseFloat(lInput.value) * 1e-3; // convert to H
    const v_rms = parseFloat(vInput.value);

    alphaValue.innerText = `${alpha}°`;

    if (fetchTimeout) clearTimeout(fetchTimeout);

    fetchTimeout = setTimeout(async () => {
        try {
            const response = await fetch('/api/simulate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alpha, r_val, l_val, v_rms })
            });
            const data = await response.json();
            
            if (response.ok) {
                renderPlot(data);
                updateMetrics(data.metrics);
            } else {
                console.error("Simulation failed:", data.detail);
            }
        } catch (e) {
            console.error("Fetch error:", e);
        }
    }, 100); // debounce
}

function renderPlot(data) {
    const t_ms = data.time.map(t => t * 1000); // Convert to ms

    const traceSource = {
        x: t_ms,
        y: data.v_source,
        mode: 'lines',
        name: 'Source Voltage (V)',
        line: { color: '#475569', width: 2, dash: 'dash' }
    };

    const traceLoad = {
        x: t_ms,
        y: data.v_load,
        mode: 'lines',
        name: 'Load Voltage (V)',
        line: { color: '#22c55e', width: 2 }
    };

    const traceCurrent = {
        x: t_ms,
        y: data.i_load,
        mode: 'lines',
        name: 'Load Current (A)',
        line: { color: '#eab308', width: 2 },
        yaxis: 'y2'
    };

    const layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#cbd5e1' },
        margin: { l: 50, r: 50, t: 20, b: 40 },
        xaxis: { title: 'Time (ms)', gridcolor: '#334155' },
        yaxis: { title: 'Voltage (V)', gridcolor: '#334155', zerolinecolor: '#334155' },
        yaxis2: {
            title: 'Current (A)',
            overlaying: 'y',
            side: 'right',
            gridcolor: 'rgba(0,0,0,0)',
            zerolinecolor: 'rgba(0,0,0,0)'
        },
        legend: { orientation: 'h', y: 1.1 }
    };

    Plotly.react('plot', [traceSource, traceLoad, traceCurrent], layout, {responsive: true});
}

function updateMetrics(metrics) {
    avgV.innerText = `${metrics.avg_v} V`;
    avgI.innerText = `${metrics.avg_i} A`;
    avgP.innerText = `${metrics.power} W`;
}

// Event Listeners
alphaSlider.addEventListener('input', updateSimulation);
rInput.addEventListener('change', updateSimulation);
lInput.addEventListener('change', updateSimulation);
vInput.addEventListener('change', updateSimulation);

// Initial Load
updateSimulation();
