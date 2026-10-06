#ifndef CPP_CORE_SWITCHES_H
#define CPP_CORE_SWITCHES_H

#pragma once

#include <cmath>
#include <algorithm>
#include "types.h"
#include "gate_signals.h"

namespace powersim {

/* ============================================================================
 * Default Parameters
 * ============================================================================ */
static constexpr double DEFAULT_RON = 1e-4;       /* Standard on-resistance (Ohm) */
static constexpr double DEFAULT_ROFF = 1e6;       /* Standard off-resistance (Ohm) */
static constexpr double DEFAULT_IHOLD = 1e-6;      /* SCR holding current threshold (A) */
static constexpr double BODY_DIODE_VTH = -1e-4;   /* Reverse body diode conduction threshold (V) */
static constexpr int DEFAULT_MAX_SWITCH_ITERS = 6;/* Max switch convergence iterations */

/**
 * Checks whether a component type corresponds to a controllable/uncontrollable switch.
 */
inline bool is_switch_type(int comp_type) {
    return (comp_type == COMP_DIODE || 
            comp_type == COMP_THYRISTOR || 
            comp_type == COMP_MOSFET);
}

/**
 * Computes switch resistance based on conduction state and parameters.
 * Returns Ron when ON, Roff when OFF.
 */
inline double get_switch_resistance(bool state, double ron = DEFAULT_RON, double roff = DEFAULT_ROFF) {
    double r_on = (ron > 0.0) ? ron : DEFAULT_RON;
    double r_off = (roff > 0.0) ? roff : DEFAULT_ROFF;
    return state ? r_on : r_off;
}

/**
 * Computes switch conductance g = 1 / R, clamped for numerical stability.
 */
inline double get_switch_conductance(bool state, double ron = DEFAULT_RON, double roff = DEFAULT_ROFF) {
    double r = get_switch_resistance(state, ron, roff);
    return 1.0 / std::max(r, 1e-12);
}

/**
 * Evaluates the new state of a Diode matching PLECS / Saber iterative method.
 *
 * Parameters:
 *   current_state: State from current/previous iteration (true=ON, false=OFF)
 *   v_diff: Anode-to-Cathode voltage (v_anode - v_cathode)
 *   i_trial: Forward trial current through diode (v_diff / R_current)
 *
 * Transitions:
 *   - When OFF: turns ON if v_diff > 0 or forward current i_trial > 0.
 *   - When ON:  turns OFF if forward current drops to zero or reverses (i_trial <= 0).
 */
inline bool evaluate_diode_state(bool current_state, double v_diff, double i_trial) {
    if (!current_state) {
        if (v_diff > 0.0 || i_trial > 0.0) {
            return true;
        }
        return false;
    } else {
        if (i_trial <= 0.0) {
            return false;
        }
        return true;
    }
}

/**
 * Evaluates the new state of a Thyristor (SCR) matching PLECS / Saber iterative method.
 *
 * Parameters:
 *   current_state: State from current/previous iteration (true=ON, false=OFF)
 *   v_diff: Anode-to-Cathode voltage (v_anode - v_cathode)
 *   i_trial: Forward trial current through SCR (v_diff / R_current)
 *   gate_active: Gate firing signal active
 *   holding_threshold: Holding current threshold (default: 1e-6 A)
 *
 * Transitions:
 *   - When OFF: turns ON if forward biased (v_diff > 0) AND gate signal is active.
 *   - When ON:  latches ON regardless of gate signal until forward current drops below
 *               holding threshold (i_trial <= 0 or i_trial <= holding_threshold).
 */
inline bool evaluate_thyristor_state(bool current_state, double v_diff, double i_trial, bool gate_active, double holding_threshold = DEFAULT_IHOLD) {
    double i_thresh = (holding_threshold > 0.0) ? holding_threshold : 0.0;
    if (!current_state) {
        if (v_diff > 0.0 && gate_active) {
            return true;
        }
        return false;
    } else {
        if (i_trial <= i_thresh) {
            return false;
        }
        return true;
    }
}

/**
 * Evaluates the new state of a MOSFET with body diode matching PLECS / Saber iterative method.
 *
 * Parameters:
 *   current_state: State from current/previous iteration (true=ON, false=OFF)
 *   v_diff: Drain-to-Source voltage (v_drain - v_source)
 *   i_trial: Drain-to-Source trial current (v_diff / R_current)
 *   gate_active: Gate control signal active (channel conducts bidirectionally)
 *   body_diode: Flag enabling anti-parallel body diode conduction (Source -> Drain)
 *   body_v_thresh: Forward threshold for body diode (default: -1e-4 V, i.e. v_source > v_drain + 0.1mV)
 *
 * Transitions:
 *   - If gate signal is active: channel conducts bidirectionally, state = ON.
 *   - If gate signal is inactive:
 *       * If body diode conducts (v_diff < body_v_thresh): turns ON.
 *       * If previously conducting via body diode and forward body current ceases (i_trial >= 0): turns OFF.
 *       * Otherwise OFF.
 */
inline bool evaluate_mosfet_state(bool current_state, double v_diff, double i_trial, bool gate_active, bool body_diode = true, double body_v_thresh = BODY_DIODE_VTH) {
    if (gate_active) {
        return true;
    }
    if (body_diode) {
        if (!current_state) {
            if (v_diff < body_v_thresh) {
                return true;
            }
            return false;
        } else {
            // Conducting in reverse via body diode: turns off when reverse current ceases
            if (i_trial >= 0.0) {
                return false;
            }
            return true;
        }
    }
    return false;
}

/**
 * Unified switch state update function dispatching by ComponentType.
 */
inline bool update_switch_state(
    int comp_type,
    bool current_state,
    double v_diff,
    double i_trial,
    bool gate_active,
    bool body_diode = true,
    double holding_current = DEFAULT_IHOLD
) {
    switch (comp_type) {
        case COMP_DIODE:
            return evaluate_diode_state(current_state, v_diff, i_trial);
        case COMP_THYRISTOR:
            return evaluate_thyristor_state(current_state, v_diff, i_trial, gate_active, holding_current);
        case COMP_MOSFET:
            return evaluate_mosfet_state(current_state, v_diff, i_trial, gate_active, body_diode);
        default:
            return current_state;
    }
}

/**
 * Stamps switch conductance into the MNA G matrix.
 *
 * Parameters:
 *   G: Pointer to flat row-major MNA conductance matrix
 *   stride: Matrix leading dimension / stride (num_vars)
 *   n1_idx: First terminal node index (>= 0, -1 for ground)
 *   n2_idx: Second terminal node index (>= 0, -1 for ground)
 *   conductance: Conductance to stamp (1 / R)
 */
inline void stamp_switch_conductance(double* G, int stride, int n1_idx, int n2_idx, double conductance) {
    if (n1_idx >= 0) {
        G[n1_idx * stride + n1_idx] += conductance;
    }
    if (n2_idx >= 0) {
        G[n2_idx * stride + n2_idx] += conductance;
    }
    if (n1_idx >= 0 && n2_idx >= 0) {
        G[n1_idx * stride + n2_idx] -= conductance;
        G[n2_idx * stride + n1_idx] -= conductance;
    }
}

/**
 * Stamps switch into MNA G matrix given state and Ron/Roff parameters.
 */
inline void stamp_switch(double* G, int stride, int n1_idx, int n2_idx, bool state, double ron, double roff) {
    double g = get_switch_conductance(state, ron, roff);
    stamp_switch_conductance(G, stride, n1_idx, n2_idx, g);
}

/* ============================================================================
 * Switch Model Class / Struct
 * ============================================================================ */

/**
 * Represents an individual switch instance with persistent state, physical parameters,
 * and stamping logic.
 */
struct SwitchModel {
    int comp_id;          /* Component identifier */
    int comp_index;       /* Index in the global components POD array (-1 if unassigned) */
    int type;             /* ComponentType: COMP_DIODE, COMP_THYRISTOR, COMP_MOSFET */
    int n1_idx;           /* Terminal 1 node index (-1 for ground) */
    int n2_idx;           /* Terminal 2 node index (-1 for ground) */
    double ron;           /* On-state resistance (Ohm) */
    double roff;          /* Off-state resistance (Ohm) */
    bool state;           /* Current state: true = ON, false = OFF */
    bool body_diode;      /* MOSFET body diode enabled */
    double holding_i;     /* Thyristor holding current threshold (A) */

    /* Gate signal configuration */
    int gate_type;        /* GateType: GATE_NONE, GATE_PULSE, GATE_PWM, GATE_CONSTANT */
    double gate_param1;   /* delay_angle (deg) or duty (%) */
    double gate_param2;   /* pulse_width (deg) or phase (deg) */
    double gate_freq;     /* Switching / fundamental frequency (Hz) */

    SwitchModel()
        : comp_id(-1), comp_index(-1), type(COMP_DIODE),
          n1_idx(-1), n2_idx(-1),
          ron(DEFAULT_RON), roff(DEFAULT_ROFF),
          state(false), body_diode(true), holding_i(DEFAULT_IHOLD),
          gate_type(GATE_NONE), gate_param1(0.0), gate_param2(0.0), gate_freq(50.0) {}

    void init(const ComponentPOD& pod, int index = -1) {
        comp_id = pod.id;
        comp_index = index;
        type = pod.type;
        n1_idx = pod.n1_idx;
        n2_idx = pod.n2_idx;
        ron = (pod.ron > 0.0) ? pod.ron : DEFAULT_RON;
        roff = (pod.roff > 0.0) ? pod.roff : DEFAULT_ROFF;
        state = false;
        body_diode = true;
        holding_i = DEFAULT_IHOLD;
        gate_type = pod.gate_type;
        gate_param1 = pod.gate_param1;
        gate_param2 = pod.gate_param2;
        gate_freq = pod.freq;
    }

    double get_resistance() const {
        return state ? ron : roff;
    }

    double get_conductance() const {
        double r = get_resistance();
        return 1.0 / std::max(r, 1e-12);
    }

    void stamp(double* G, int stride) const {
        double g = get_conductance();
        stamp_switch_conductance(G, stride, n1_idx, n2_idx, g);
    }

    bool evaluate_gate(double t, double default_freq = 50.0) const {
        double f = (gate_freq > 0.0) ? gate_freq : default_freq;
        return evaluate_gate_signal(gate_type, gate_param1, gate_param2, f, t, default_freq);
    }

    /**
     * Updates switch state given terminal potentials v1 and v2, and gate signal.
     * Returns true if switch state transitioned (OFF->ON or ON->OFF).
     */
    bool update_state(double v1, double v2, bool gate_signal) {
        double v_diff = v1 - v2;
        double r_curr = get_resistance();
        double i_trial = v_diff / r_curr;
        bool old_state = state;

        state = update_switch_state(type, state, v_diff, i_trial, gate_signal, body_diode, holding_i);
        return (state != old_state);
    }

    /**
     * Updates switch state given solved potential vector x.
     */
    bool update_from_solution(const double* x, int num_vars, bool gate_signal) {
        double v1 = (n1_idx >= 0 && n1_idx < num_vars) ? x[n1_idx] : 0.0;
        double v2 = (n2_idx >= 0 && n2_idx < num_vars) ? x[n2_idx] : 0.0;
        return update_state(v1, v2, gate_signal);
    }

    double get_voltage(const double* x, int num_vars) const {
        double v1 = (n1_idx >= 0 && n1_idx < num_vars) ? x[n1_idx] : 0.0;
        double v2 = (n2_idx >= 0 && n2_idx < num_vars) ? x[n2_idx] : 0.0;
        return v1 - v2;
    }

    double get_current(const double* x, int num_vars) const {
        return get_voltage(x, num_vars) / get_resistance();
    }

    double get_power(const double* x, int num_vars) const {
        double v = get_voltage(x, num_vars);
        double i = v / get_resistance();
        return v * i;
    }
};

/* ============================================================================
 * Switch Network Manager (Multi-Pass Iterative Switch Convergence)
 * ============================================================================ */

/**
 * Manages all switches in a circuit and implements the PLECS / Saber iterative method.
 */
struct SwitchNetwork {
    static constexpr int MAX_SWITCHES = 64;
    SwitchModel switches[MAX_SWITCHES];
    int count = 0;
    int max_iters = DEFAULT_MAX_SWITCH_ITERS;

    void clear() {
        count = 0;
    }

    bool add_switch(const ComponentPOD& pod, int comp_index = -1) {
        if (!is_switch_type(pod.type)) return false;
        if (count >= MAX_SWITCHES) return false;
        switches[count].init(pod, comp_index);
        count++;
        return true;
    }

    void init_from_components(const ComponentPOD* comps, int num_comps) {
        clear();
        if (!comps) return;
        for (int i = 0; i < num_comps; ++i) {
            if (is_switch_type(comps[i].type)) {
                add_switch(comps[i], i);
            }
        }
    }

    void stamp_all(double* G, int stride) const {
        for (int i = 0; i < count; ++i) {
            switches[i].stamp(G, stride);
        }
    }

    /**
     * Checks transitions for all switches given the latest solved potentials x and time t.
     * Evaluates analytic gate signals automatically.
     * Returns true if ANY switch state changed (signaling that another solver iteration is required).
     */
    bool check_transitions(const double* x, int num_vars, double t, double default_freq = 50.0) {
        bool any_changed = false;
        for (int i = 0; i < count; ++i) {
            bool gate = switches[i].evaluate_gate(t, default_freq);
            if (switches[i].update_from_solution(x, num_vars, gate)) {
                any_changed = true;
            }
        }
        return any_changed;
    }

    /**
     * Checks transitions with externally supplied gate signal flags.
     * Returns true if ANY switch state changed.
     */
    bool check_transitions_with_gates(const double* x, int num_vars, const bool* gate_signals) {
        bool any_changed = false;
        for (int i = 0; i < count; ++i) {
            bool gate = gate_signals ? gate_signals[i] : false;
            if (switches[i].update_from_solution(x, num_vars, gate)) {
                any_changed = true;
            }
        }
        return any_changed;
    }

    /**
     * Records switch states (1.0 for ON, 0.0 for OFF) into caller's results buffer.
     * Buffer layout: [num_components * n_steps] (row-major).
     */
    void record_states(double* switch_results_buf, int n_steps, int step_i) const {
        if (!switch_results_buf) return;
        for (int i = 0; i < count; ++i) {
            int c_idx = switches[i].comp_index;
            if (c_idx >= 0) {
                switch_results_buf[c_idx * n_steps + step_i] = switches[i].state ? 1.0 : 0.0;
            }
        }
    }
};

} // namespace powersim

/* ============================================================================
 * C ABI Wrappers
 * ============================================================================ */
#ifdef __cplusplus
extern "C" {
#endif

inline int powersim_evaluate_diode(int current_state, double v_diff, double i_trial) {
    return powersim::evaluate_diode_state(current_state != 0, v_diff, i_trial) ? 1 : 0;
}

inline int powersim_evaluate_thyristor(int current_state, double v_diff, double i_trial, int gate_active, double holding_threshold) {
    return powersim::evaluate_thyristor_state(current_state != 0, v_diff, i_trial, gate_active != 0, holding_threshold) ? 1 : 0;
}

inline int powersim_evaluate_mosfet(int current_state, double v_diff, double i_trial, int gate_active, int body_diode, double body_v_thresh) {
    return powersim::evaluate_mosfet_state(current_state != 0, v_diff, i_trial, gate_active != 0, body_diode != 0, body_v_thresh) ? 1 : 0;
}

inline double powersim_get_switch_resistance(int state, double ron, double roff) {
    return powersim::get_switch_resistance(state != 0, ron, roff);
}

inline double powersim_get_switch_conductance(int state, double ron, double roff) {
    return powersim::get_switch_conductance(state != 0, ron, roff);
}

inline void powersim_stamp_switch_conductance(double* G, int stride, int n1_idx, int n2_idx, double conductance) {
    powersim::stamp_switch_conductance(G, stride, n1_idx, n2_idx, conductance);
}

#ifdef __cplusplus
}
#endif

#endif /* CPP_CORE_SWITCHES_H */
