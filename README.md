# PowerSim PRO: Interactive Power Electronics CAD & Transient Simulator

[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-009688.svg?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB.svg?logo=python&logoColor=white)](https://www.python.org/)
[![Plotly.js](https://img.shields.io/badge/Plotly.js-2.29+-3F4F75.svg?logo=plotly&logoColor=white)](https://plotly.com/javascript/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/Release-Beta%201.2-cyan.svg)](https://github.com/Aryan9372/PowerElectronicsSimulator/releases)

**PowerSim PRO** is a high-performance, browser-based power electronics schematic CAD and numerical circuit simulator. Designed for power electronics engineers, researchers, and students, it provides an intuitive drag-and-drop schematic canvas, a Modified Nodal Analysis (MNA) transient solver with iterative switch consistency, dynamic current flow animation, and an interactive dual-mode oscilloscope with customizable transient viewing horizons.

---

## ⚡ Key Features

### 1. Interactive Schematic CAD Builder
- **Component Palette**: AC/DC voltage sources, Resistors, Inductors, Capacitors, Diodes, Thyristors (SCRs), MOSFETs, and Ground references.
- **Wire Routing & Snap Grid**: Automatic junction node clustering (`netMap`), orthogonal wiring, snap-to-terminal halos, component rotation (`R`), and deletion (`Delete`/`Backspace`).
- **Live Property Inspector**: Real-time parameter tweaking for voltages, resistances, inductances, capacitances, initial pre-charge voltages ($v_0$), thyristor firing angles ($\alpha$), PWM frequencies, and duty cycles ($D$).

### 2. High-Performance Transient MNA Physics Engine
- **Modified Nodal Analysis (MNA)**: Fully dynamic conductance matrix stamping ($G$) and right-hand side excitation vector ($I$).
- **Iterative Switch Consistency (PLECS/Saber Algorithm)**: Multi-pass inner convergence loop resolving ideal diode turn-on, thyristor latching & commutation, and MOSFET reverse body-diode conduction in continuous (CCM) and discontinuous (DCM) conduction modes.
- **Companion Models**: Trapezoidal and Backward-Euler numerical integration for energy storage elements (inductors and capacitors).
- **Backend Processing Integrity**: Full numerical calculation is executed on the server with zero client-side downsampling or decimation.

### 3. Comprehensive Library of 17+ Circuit Presets
Instant 1-click loading for standard power electronic topologies:
- **DC-DC Converters**:
  - Buck Converter ($5\text{ kHz}$ PWM, LC filter)
  - Boost Converter ($5\text{ kHz}$ PWM)
  - Buck-Boost Converter (Inverting polarity)
  - Ćuk Converter (Capacitive energy transfer)
  - SEPIC Converter (Non-inverting buck-boost)
- **Single-Phase AC-DC Rectifiers**:
  - 1Φ Half-Wave Uncontrolled Diode Rectifier
  - 1Φ Half-Wave Controlled Thyristor (SCR) Rectifier ($\alpha = 45^\circ$)
  - 1Φ Full-Bridge Diode Rectifier
  - 1Φ Full-Bridge Controlled Thyristor Bridge ($\alpha = 45^\circ$)
  - 1Φ Semi-Converter (2 SCRs + 2 Diodes + Freewheeling Diode)
- **Three-Phase AC-DC Converters**:
  - 3Φ Half-Wave Diode Rectifier
  - 3Φ Half-Wave Controlled SCR Rectifier ($\alpha = 60^\circ, 180^\circ, 300^\circ$)
  - 3Φ 6-Diode Bridge Rectifier
  - 3Φ 6-Pulse Controlled SCR Bridge Rectifier ($60^\circ$ conduction sequence)
  - 3Φ Semi-Converter (3 SCRs + 3 Diodes + FWD)
- **DC-AC Inverters**:
  - 1Φ H-Bridge Inverter (4 MOSFETs, complementary PWM)
  - 3Φ 6-Switch Voltage Source Inverter (VSI driving balanced 3-phase star load)
  - Inverter Half-Bridge Leg

### 4. Dual-Mode Oscilloscope & Transient Horizon Selector
- **⚡ Steady-State Mode (1 Cycle)**: Locks the oscilloscope time window strictly to the fundamental periodic cycle ($T = 1/f$), providing clean ripple analysis with a continuous 60 FPS sweeping cursor.
- **📈 Full Transient Mode**: Displays the complete startup inrush, capacitor pre-charging, and inductor settling trajectory.
- **Interactive View Duration Selector**:
  - Quick 1-click preset pills: `[ 20 ms ]`, `[ 50 ms ]`, `[ 100 ms ]`, `[ 200 ms ]`, `[ Full Timeline ]`.
  - Continuous duration range slider and fine numeric input.
  - Auto-Extension: Automatically extends the simulation run if the selected view duration exceeds the current solved timeline.
- **Plotly Range Slider**: Native mini-overview map beneath the waveform with draggable handles for interactive zooming and panning.
- **Click-to-Scrub Time Inspection**: Click anywhere on the plot canvas to freeze time and inspect the circuit operating point with a glowing amber badge. Clicking "Resume Sweep" resumes normal continuous playback.

### 5. Real-Time Circuit Animation & Conduction Telemetry
- **Animated Current Particles**: Moving electron particles flow along wires and through active components, with speeds proportional to instantaneous branch currents.
- **Active Switch Glow**: Conducting diodes, thyristors, and MOSFETs glow emerald green with dynamic neon drop-shadows.
- **Active Conduction Badge**: Real-time HUD status badge reporting currently conducting switches (e.g., `Active Switches: T1 + T2 (ON)` vs `All Switches OFF`).
- **Slow-Motion Playback**: Variable animation speed scaling ($0.01\text{x}$ slow motion up to $2.0\text{x}$) and Phase Angle ($\omega t$) slider.

### 6. Windowed Statistics, CSV Export & Hotkeys
- **Electrical Metrics**: Live calculation of Average Voltage ($V_{\text{avg}}$), RMS Voltage ($V_{\text{rms}}$), Ripple Factor ($\text{RF} = \sqrt{(V_{\text{rms}}/|V_{\text{avg}}|)^2 - 1}$), Peak-to-Peak Voltage, Average Current ($I_{\text{avg}}$), and Active Power ($P$).
- **Windowed Sub-Intervals (`stats_window`)**: Metrics automatically adapt to whatever transient time window is currently selected.
- **1-Click CSV Export**: Download the visible transient window as a structured CSV file (`powersim_transient_data.csv`).
- **Keyboard Shortcuts**:
  - `[` / `]`: Step down / step up visible transient viewing duration
  - `ArrowLeft` / `ArrowRight`: Step scrubbed inspection time backward / forward by $1\text{ ms}$
  - `Space`: Toggle Pause / Resume continuous sweep
  - `1`, `2`, `3`, `4`, `0`: Direct jump to $20\text{ ms}$, $50\text{ ms}$, $100\text{ ms}$, $200\text{ ms}$, and Full Timeline presets
  - `R`: Rotate selected component
  - `Delete` / `Backspace`: Remove selected component

---

## 🚀 Getting Started

### Prerequisites
- Python 3.10, 3.11, or 3.12
- Web browser (Chrome, Edge, Firefox, or Safari)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Aryan9372/PowerElectronicsSimulator.git
   cd PowerElectronicsSimulator
   ```

2. **Create and activate a virtual environment**:
   - **Windows (PowerShell)**:
     ```powershell
     python -m venv .venv
     .\.venv\Scripts\Activate.ps1
     ```
   - **macOS / Linux**:
     ```bash
     python3 -m venv .venv
     source .venv/bin/activate
     ```

3. **Install dependencies**:
   ```bash
   pip install --upgrade pip
   pip install fastapi uvicorn numpy pydantic
   ```

### Running the Simulator

Start the application with Uvicorn:
```bash
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open your browser and navigate to:
```text
http://127.0.0.1:8000
```

The server automatically serves the interactive CAD builder at `http://127.0.0.1:8000/builder.html`.

---

## 📁 Project Structure

```text
PowerElectronicsSimulator/
├── app.py                         # FastAPI backend, routing & simulation endpoints
├── core/
│   ├── engine.py                  # High-performance MNA transient simulation engine
│   ├── parser.py                  # JSON netlist parser & simulator builder
│   └── components.py              # Component models (R, L, C, V_DC, V_AC, Diode, SCR, MOSFET)
├── static/
│   ├── builder.html               # Main CAD workbench interface
│   ├── builder.js                 # Canvas CAD engine, Plotly oscilloscope & animation loop
│   ├── eng_units.js               # Engineering unit auto-scaling (ns, μs, ms, s, kV, mA)
│   ├── export_utils.js            # High-precision CSV data exporter
│   ├── shortcuts.js               # Keyboard shortcuts & hotkey controller
│   └── view_history.js            # Oscilloscope zoom navigation & history stack
├── tests/
│   ├── benchmark_transient_speed.py   # Solver execution benchmarks
│   ├── verify_all_presets_transient.py# Automated verification of all 17 presets
│   ├── verify_conduction_sync.py      # Conduction angle & switch glow validation
│   ├── verify_transient_inrush.py     # RLC step response & capacitor inrush physics audit
│   └── verify_window_metrics_math.py  # Analytical validation of electrical formulas
├── test_transient_integration_qa.py   # Full integration QA test suite
├── transient_duration_feature.md      # Multi-agent architectural collaboration board
└── README.md                          # Project documentation
```

---

## 🧪 Testing & Verification

Run the comprehensive QA and physics verification test suite:

```bash
# Verify windowed metrics and auto-extension
python test_window_feature.py

# Run comprehensive integration QA and benchmarks
python test_transient_integration_qa.py

# Verify mathematical accuracy of all 17 presets
python tests/verify_all_presets_transient.py

# Run RLC resonance and inrush current dynamics audit
python tests/verify_transient_inrush.py
```

All tests execute against live endpoints and verify numerical accuracy against analytical transfer function solutions.

---

## 🏷️ Release History

- **Beta 1.2** *(Current)*:
  - Added interactive Transient Viewing Horizon controls ($20\text{ ms}$, $50\text{ ms}$, $100\text{ ms}$, $200\text{ ms}$, Full Timeline).
  - Integrated Plotly interactive range slider mini-map with bidirectional synchronization.
  - Sliced windowed statistics (`stats_window`) evaluated with pure NumPy precision.
  - Multi-scale engineering unit formatting (`ns`, `μs`, `ms`, `s`).
  - 1-Click CSV waveform exporter and full keyboard hotkey support.
  - Restructured real-time playback HUD bar to ensure full Phase Angle ($\omega t$) slider visibility.
  - 100% automated test suites across all 17 circuit presets.
- **Beta 1.1**:
  - Expanded preset library to 17 power electronic topologies (Buck, Boost, Buck-Boost, Ćuk, SEPIC, 1Φ & 3Φ rectifiers, inverters).
  - Multi-phase AC sources ($0^\circ, -120^\circ, +120^\circ$) with degree/radian support.
  - Real-time current flow electron particles and dynamic switch conduction glowing.
  - Slow-motion animation scaling down to $0.01\text{x}$.
- **Beta 1.0**:
  - Initial interactive CAD canvas with netlist extraction.
  - Pure Python MNA solver with iterative switch consistency.
  - Single-phase full-bridge thyristor rectifier simulation.

---

## 📜 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
