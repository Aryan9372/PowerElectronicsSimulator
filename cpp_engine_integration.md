# Shared Collaboration Board: Blazing Fast C++ Engine Integration & UI Feedback Fix

**Document**: `cpp_engine_integration.md`  
**Location**: `C:\Users\aryan nag\Desktop\PowerElectronicsSimulator\cpp_engine_integration.md`  
**Status**: Active - 10 Autonomous Agents Working in Parallel  
**Compiler**: MinGW-w64 GCC `g++.exe 16.1.0` (`-O3 -mavx2 -shared -static`)  
**Bridge**: Python standard library `ctypes` (Zero-copy NumPy pointer mapping)  
**Goal**: **50x–100x speedup** (< 2 ms for 10,000 steps) + Clear Real-Time UI Feedback for Run Simulation

---

## 1. Team Roster & Division of Labor (10 Agents)

| Agent | Role | Target Deliverable | Responsibilities |
|---|---|---|---|
| **Agent C1** | **C ABI & Core Types Engineer** | `cpp_core/types.h` | Define C-compatible POD structs (`ComponentPOD`, `SimConfigPOD`, `SimResultsPOD`, `StatsPOD`). |
| **Agent C2** | **MNA Linear Solver Engineer** | `cpp_core/linear_solver.h` | In-place partial-pivoting Gaussian elimination & regularization for dense MNA systems ($N \le 64$). |
| **Agent C3** | **Companion Models & LC Integrator** | `cpp_core/companion.h` | Trapezoidal companion conductances and history currents for inductors and capacitors. |
| **Agent C4** | **Switch Consistency & Gate Controller** | `cpp_core/switches.h`, `cpp_core/gate_signals.h` | Multi-pass iterative switch convergence (PLECS algorithm) for Diodes, Thyristors, MOSFETs, and gate waveforms. |
| **Agent C5** | **Engine Assembly & Export Specialist** | `cpp_core/engine.cpp` | Main time-stepping loop, SIMD metric calculator, and `extern "C" __declspec(dllexport)` entry point. |
| **Agent C6** | **Build & Compilation Engineer** | `build_native.bat`, `powersim_engine.dll` | Automated compile script with `g++ -O3 -mavx2 -shared -fPIC -static`, symbol verification. |
| **Agent C7** | **Python ctypes Zero-Copy Bridge** | `core/cpp_bridge.py` | Python ctypes wrapper passing NumPy memory pointers directly to C++ with zero copying. |
| **Agent C8** | **API & Server Integration Engineer** | `app.py` | Route `/api/simulate_custom` to C++ engine with seamless fallback to pure Python `core/engine.py`. |
| **Agent C9** | **UI Run Feedback & Status Badging** | `static/builder.html`, `static/builder.js` | Fix Run Simulation feedback: add `#simStatusBadge`, elapsed solve time, toast alerts, and simulation watchdog. |
| **Agent C10** | **Parity Verification & Benchmark Lead** | `tests/verify_cpp_parity.py`, `tests/benchmark_cpp_vs_python.py` | Test numerical accuracy vs Python ($< 10^{-5}$ error) and benchmark speedup across all presets. |

---

## 2. Technical Contracts & Data Structures

### A. C ABI Struct Definitions (`cpp_core/types.h`)
```c
enum ComponentType {
    COMP_RESISTOR = 0,
    COMP_CAPACITOR = 1,
    COMP_INDUCTOR = 2,
    COMP_V_DC = 3,
    COMP_V_AC = 4,
    COMP_DIODE = 5,
    COMP_THYRISTOR = 6,
    COMP_MOSFET = 7
};

typedef struct {
    int id;
    int type;
    int n1_idx;
    int n2_idx;
    double value;
    double amplitude;
    double freq;
    double phase_rad;
    double ron;
    double roff;
    double v0;
    double i0;
    int gate_type;      // 0=none, 1=pulse, 2=pwm, 3=constant
    double gate_param1; // delay_angle or duty
    double gate_param2; // pulse_width or phase
} ComponentPOD;

typedef struct {
    double t_end;
    double dt;
    int method;
    int num_nodes;
    int num_components;
    int num_vsources;
    int n_steps;
    double win_t_start;
    double win_t_end;
    double steady_t_start;
    double steady_t_end;
} SimConfigPOD;

typedef struct {
    double avg;
    double rms;
    double pk_pk;
    double max_val;
    double min_val;
    double power;
    double rf;
} MetricPOD;
```

---

## 3. Live Progress Checklist

### C++ Native Core
- [x] **Agent C1**: Create `cpp_core/types.h`
- [x] **Agent C2**: Create `cpp_core/linear_solver.h`
- [x] **Agent C3**: Create `cpp_core/companion.h`
- [x] **Agent C4**: Create `cpp_core/switches.h` and `cpp_core/gate_signals.h`
- [ ] **Agent C5**: Create `cpp_core/engine.cpp`
- [ ] **Agent C6**: Build and verify `powersim_engine.dll` using `g++.exe`

### Python Integration
- [ ] **Agent C7**: Implement `core/cpp_bridge.py`
- [ ] **Agent C8**: Integrate into `app.py` with automatic fallback

### Frontend UI Simulation Feedback
- [ ] **Agent C9**: Fix Run Simulation UI feedback (add `#simStatusBadge`, "Solved in X ms" badge, watchdog)

### Verification & Benchmarking
- [ ] **Agent C10**: Run parity and speed benchmark tests

---

## 4. Agent Communication Log
- **Lead Agent**: Board initialized with 10 agent specifications. Proceeding with simultaneous subagent deployment.
- **Agent C1 (Core Types)**: Completed `cpp_core/types.h` defining C ABI POD structures (`ComponentType`, `GateType`, `IntegrationMethod`, `ComponentPOD`, `SimConfigPOD`, `MetricPOD`, `SimResultsPOD`). Verified syntax with `g++`.
- **Agent C2 (MNA Linear Solver)**: Completed `cpp_core/linear_solver.h`. Implemented in-place dense Gaussian Elimination with partial row pivoting for MNA systems ($N \le 64$), dynamic regularization ($10^{-6}$) for singular/floating nodes, forward elimination, back-substitution, and MNA stamping functions (`stamp_resistor`, `stamp_gmin`, `stamp_conductance`, `stamp_vsource`, `stamp_current_source`). Verified numerical correctness on 3x3 general and MNA circuits with zero-diagonal sources via `tests/test_linear_solver.cpp` (throughput: 22.9M solves/sec, 43.6 ns per 3x3 solve).
- **Agent C3 (Companion Models & LC Integrator)**: Completed `cpp_core/companion.h`. Implemented companion models matching `core/engine.py`:
  - Capacitors: Trapezoidal ($R_{eq} = \frac{\Delta t}{2C}$, $I_{eq} = \frac{2C}{\Delta t} v_{prev} + i_{prev}$) and Backward-Euler ($R_{eq} = \frac{\Delta t}{C}$, $I_{eq} = \frac{C}{\Delta t} v_{prev}$).
  - Inductors: Trapezoidal ($R_{eq} = \frac{2L}{\Delta t}$, $I_{eq} = i_{prev} + \frac{\Delta t}{2L} v_{prev}$) and Backward-Euler ($R_{eq} = \frac{L}{\Delta t}$, $I_{eq} = i_{prev}$).
  - Provided state structures (`CapacitorCompanion`, `InductorCompanion`), conductances and RHS current stampers (`stamp_capacitor_conductance`, `stamp_inductor_conductance`, `stamp_capacitor_current`, `stamp_inductor_current`), post-solve branch/history updates (`companion_cap_update`, `companion_ind_update`), and batch base stamping (`companion_stamp_all_base`). Verified with `tests/test_companion.cpp` (zero warnings with `-O3 -Wall -Wextra`, passes all tests).
- **Agent C4 (Switch Consistency & Gate Controller)**: Completed `cpp_core/gate_signals.h` and `cpp_core/switches.h`:
  - `gate_signals.h`: Implemented analytic gate signal evaluation at time $t$ for all switch types:
    * Pulse gate: delay angle $\alpha$ (deg), pulse width $W$ (deg), frequency $f$, electrical angle $\theta = (2\pi f t \cdot 180 / \pi) \pmod{360}$, full wrap-around window handling.
    * PWM gate: duty cycle $D$ (0-100%), phase $\phi$ (deg), frequency $f$, carrier offset $t_c = (t + t_{\text{offset}}) \pmod{T}$, pulse comparator $t_c \le D \cdot T$.
    * Constant gate: binary state evaluation.
  - `switches.h`: Implemented switch state tracking and resistance stamping matching PLECS / Saber iterative method:
    * Diode: turns ON if $v_{diff} > 0$ or forward current $i_{trial} > 0$; turns OFF if $i_{trial} \le 0$.
    * Thyristor (SCR): turns ON if $v_{diff} > 0$ AND gate signal active; latches ON until $i_{trial} \le I_{hold}$ ($10^{-6}\text{ A}$ or $0\text{ A}$).
    * MOSFET: turns ON if gate active (bidirectional) OR reverse body diode conducts ($v_{diff} < -10^{-4}\text{ V}$); turns OFF when body diode current drops to 0 ($i_{trial} \ge 0$).
    * Resistance & Conductance: returns $R_{on}$ ($10^{-4}\,\Omega$) when ON, $R_{off}$ ($10^6\,\Omega$) when OFF, stamped directly into MNA $G$ matrix with ground handling.
    * Structs & Convergence: `SwitchModel`, `SwitchNetwork` with multi-pass convergence loop (`check_transitions`), branch measurement helpers (`get_voltage`, `get_current`, `get_power`), and C ABI exports. Verified with `-O3 -Wall -Wextra` unit test suite `cpp_core/test_switches_and_gates.cpp` (100% assertions passed).
