/**
 * PowerSim PRO - Multi-Scale Engineering Unit Formatter
 * static/eng_units.js
 * 
 * Provides standard engineering unit formatting for power electronics simulations:
 * - Time: ns, μs, ms, s
 * - Voltage: MV, kV, V, mV, μV
 * - Current: MA, kA, A, mA, μA
 * - Frequency: GHz, MHz, kHz, Hz, mHz
 */

(function () {
    /**
     * Formats simulation time into standard engineering units.
     * @param {number} valInSeconds - Time duration or timestamp in seconds.
     * @param {number} [precision=2] - Number of decimal places to format.
     * @returns {string} Formatted string with engineering unit (ns, μs, ms, s).
     */
    function formatTime(valInSeconds, precision = 2) {
        if (valInSeconds == null || isNaN(valInSeconds)) return `0.00 s`;
        const val = Number(valInSeconds);
        const abs = Math.abs(val);

        if (abs < 1e-6) {
            return `${(val * 1e9).toFixed(precision)} ns`;
        } else if (abs < 1e-3) {
            return `${(val * 1e6).toFixed(precision)} μs`;
        } else if (abs < 1.0) {
            return `${(val * 1e3).toFixed(precision)} ms`;
        } else {
            return `${val.toFixed(precision)} s`;
        }
    }

    /**
     * Formats voltage into standard engineering units.
     * @param {number} valInVolts - Voltage value in volts.
     * @param {number} [precision=2] - Number of decimal places to format.
     * @returns {string} Formatted string with engineering unit (MV, kV, V, mV, μV, nV).
     */
    function formatVoltage(valInVolts, precision = 2) {
        if (valInVolts == null || isNaN(valInVolts)) return `0.00 V`;
        const val = Number(valInVolts);
        const abs = Math.abs(val);

        if (abs === 0) {
            return `${(0).toFixed(precision)} V`;
        } else if (abs >= 1e6) {
            return `${(val / 1e6).toFixed(precision)} MV`;
        } else if (abs >= 1e3) {
            return `${(val / 1e3).toFixed(precision)} kV`;
        } else if (abs >= 1.0) {
            return `${val.toFixed(precision)} V`;
        } else if (abs >= 1e-3) {
            return `${(val * 1e3).toFixed(precision)} mV`;
        } else if (abs >= 1e-6) {
            return `${(val * 1e6).toFixed(precision)} μV`;
        } else {
            return `${(val * 1e9).toFixed(precision)} nV`;
        }
    }

    /**
     * Formats current into standard engineering units.
     * @param {number} valInAmps - Current value in amperes.
     * @param {number} [precision=2] - Number of decimal places to format.
     * @returns {string} Formatted string with engineering unit (MA, kA, A, mA, μA, nA).
     */
    function formatCurrent(valInAmps, precision = 2) {
        if (valInAmps == null || isNaN(valInAmps)) return `0.00 A`;
        const val = Number(valInAmps);
        const abs = Math.abs(val);

        if (abs === 0) {
            return `${(0).toFixed(precision)} A`;
        } else if (abs >= 1e6) {
            return `${(val / 1e6).toFixed(precision)} MA`;
        } else if (abs >= 1e3) {
            return `${(val / 1e3).toFixed(precision)} kA`;
        } else if (abs >= 1.0) {
            return `${val.toFixed(precision)} A`;
        } else if (abs >= 1e-3) {
            return `${(val * 1e3).toFixed(precision)} mA`;
        } else if (abs >= 1e-6) {
            return `${(val * 1e6).toFixed(precision)} μA`;
        } else {
            return `${(val * 1e9).toFixed(precision)} nA`;
        }
    }

    /**
     * Formats frequency into standard engineering units.
     * @param {number} valInHz - Frequency value in Hertz.
     * @param {number} [precision=1] - Number of decimal places to format.
     * @returns {string} Formatted string with engineering unit (GHz, MHz, kHz, Hz, mHz).
     */
    function formatFrequency(valInHz, precision = 1) {
        if (valInHz == null || isNaN(valInHz)) return `0.0 Hz`;
        const val = Number(valInHz);
        const abs = Math.abs(val);

        if (abs === 0) {
            return `${(0).toFixed(precision)} Hz`;
        } else if (abs >= 1e9) {
            return `${(val / 1e9).toFixed(precision)} GHz`;
        } else if (abs >= 1e6) {
            return `${(val / 1e6).toFixed(precision)} MHz`;
        } else if (abs >= 1e3) {
            return `${(val / 1e3).toFixed(precision)} kHz`;
        } else if (abs >= 1.0) {
            return `${val.toFixed(precision)} Hz`;
        } else if (abs >= 1e-3) {
            return `${(val * 1e3).toFixed(precision)} mHz`;
        } else {
            return `${val.toFixed(precision)} Hz`;
        }
    }

    const EngUnits = {
        formatTime,
        formatVoltage,
        formatCurrent,
        formatFrequency
    };

    if (typeof window !== 'undefined') {
        window.EngUnits = EngUnits;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = EngUnits;
    }
})();
