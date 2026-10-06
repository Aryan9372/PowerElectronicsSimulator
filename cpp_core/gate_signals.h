#ifndef CPP_CORE_GATE_SIGNALS_H
#define CPP_CORE_GATE_SIGNALS_H

#pragma once

#include <cmath>
#include "types.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace powersim {

/**
 * Normalizes an angle in degrees to the [0.0, 360.0) range.
 */
inline double normalize_angle_deg(double angle_deg) {
    double a = std::fmod(angle_deg, 360.0);
    if (a < 0.0) {
        a += 360.0;
    }
    return a;
}

/**
 * Computes electrical angle theta in degrees at time t given frequency f (Hz):
 * theta = (2 * pi * f * t * 180 / pi) % 360
 */
inline double compute_electrical_angle_deg(double t, double freq) {
    if (freq <= 0.0) return 0.0;
    double period = 1.0 / freq;
    double t_c = std::fmod(t, period);
    if (t_c < 0.0) {
        t_c += period;
    }
    double theta = (2.0 * M_PI * freq * t_c) * (180.0 / M_PI);
    return normalize_angle_deg(theta);
}

/**
 * Evaluates a pulse gate signal at time t.
 *
 * Parameters:
 *   t: Current simulation time (s)
 *   freq: Fundamental frequency (Hz)
 *   delay_angle_deg: Firing delay angle alpha in degrees
 *   pulse_width_deg: Pulse conduction width in degrees
 *   default_freq: Fallback frequency if freq <= 0 (default: 50.0 Hz)
 *
 * Algorithm:
 *   Computes electrical angle theta = (2 * pi * f * t * 180 / pi) % 360.
 *   Returns true if theta is within the firing window [alpha, alpha + pulse_width] (with 360 wrap).
 */
inline bool evaluate_pulse_gate(double t, double freq, double delay_angle_deg, double pulse_width_deg, double default_freq = 50.0) {
    if (freq <= 0.0) {
        freq = (default_freq > 0.0) ? default_freq : 50.0;
    }
    if (pulse_width_deg <= 0.0) {
        return false;
    }
    if (pulse_width_deg >= 360.0) {
        return true;
    }

    double theta = compute_electrical_angle_deg(t, freq);
    double alpha = normalize_angle_deg(delay_angle_deg);
    double end_angle = alpha + pulse_width_deg;

    if (end_angle <= 360.0) {
        return (theta >= alpha && theta <= end_angle);
    } else {
        double wrapped_end = std::fmod(end_angle, 360.0);
        return (theta >= alpha || theta <= wrapped_end);
    }
}

/**
 * Evaluates a PWM gate signal at time t.
 *
 * Parameters:
 *   t: Current simulation time (s)
 *   freq: Switching frequency (Hz)
 *   duty_percent: Duty cycle D (0.0 to 100.0%)
 *   phase_deg: Carrier phase shift phi in degrees
 *   default_freq: Fallback frequency if freq <= 0 (default: 50.0 Hz)
 *
 * Algorithm:
 *   Carrier period T = 1 / f.
 *   Offset time t_offset = (phi / 360) * T.
 *   Time within carrier cycle t_c = (t + t_offset) % T.
 *   Returns true if t_c <= (D / 100) * T.
 */
inline bool evaluate_pwm_gate(double t, double freq, double duty_percent, double phase_deg, double default_freq = 50.0) {
    if (freq <= 0.0) {
        freq = (default_freq > 0.0) ? default_freq : 50.0;
    }
    if (duty_percent <= 0.0) {
        return false;
    }
    if (duty_percent >= 100.0) {
        return true;
    }

    double period = 1.0 / freq;
    double t_offset = (phase_deg / 360.0) * period;
    double t_c = std::fmod(t + t_offset, period);
    if (t_c < 0.0) {
        t_c += period;
    }

    double on_time = (duty_percent / 100.0) * period;
    return (t_c <= on_time);
}

/**
 * Evaluates a constant gate signal.
 *
 * Parameters:
 *   state_val: Boolean flag (0.0 = OFF / false, non-zero / > 0.5 = ON / true)
 */
inline bool evaluate_constant_gate(double state_val) {
    return (state_val > 0.5 || state_val < -0.5);
}

/**
 * Evaluates analytic gate signal given explicit gate parameters.
 */
inline bool evaluate_gate_signal(int gate_type, double param1, double param2, double freq, double t, double default_freq = 50.0) {
    switch (gate_type) {
        case GATE_PULSE:
            return evaluate_pulse_gate(t, freq, param1, param2, default_freq);
        case GATE_PWM:
            return evaluate_pwm_gate(t, freq, param1, param2, default_freq);
        case GATE_CONSTANT:
            return evaluate_constant_gate(param1);
        case GATE_NONE:
        default:
            return false;
    }
}

/**
 * Evaluates analytic gate signal for a ComponentPOD at time t.
 */
inline bool evaluate_gate_signal(const ComponentPOD& comp, double t, double default_freq = 50.0) {
    double f = (comp.freq > 0.0) ? comp.freq : default_freq;
    return evaluate_gate_signal(comp.gate_type, comp.gate_param1, comp.gate_param2, f, t, default_freq);
}

} // namespace powersim

/* ============================================================================
 * C ABI Wrappers
 * ============================================================================ */
#ifdef __cplusplus
extern "C" {
#endif

inline int powersim_evaluate_gate(int gate_type, double param1, double param2, double freq, double t, double default_freq) {
    return powersim::evaluate_gate_signal(gate_type, param1, param2, freq, t, default_freq) ? 1 : 0;
}

inline int powersim_evaluate_component_gate(const ComponentPOD* comp, double t, double default_freq) {
    if (!comp) return 0;
    return powersim::evaluate_gate_signal(*comp, t, default_freq) ? 1 : 0;
}

#ifdef __cplusplus
}
#endif

#endif /* CPP_CORE_GATE_SIGNALS_H */
