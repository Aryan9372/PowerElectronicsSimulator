from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn
import math
import numpy as np
from core.parser import build_from_json

app = FastAPI()

class SimulationRequest(BaseModel):
    alpha: float
    r_val: float
    l_val: float
    v_rms: float

def get_gate_signals_func(alpha_deg, freq=50.0):
    period = 1.0 / freq
    omega = 2 * math.pi * freq
    alpha_rad = math.radians(alpha_deg)
    
    # Times for zero crossings
    def get_signals(t):
        t_cycle = t % period
        angle = omega * t_cycle
        
        signals = {}
        
        # Positive half cycle: T1 and T2
        if angle >= alpha_rad and angle < math.pi:
            signals['T1'] = True
            signals['T2'] = True
        else:
            signals['T1'] = False
            signals['T2'] = False
            
        # Negative half cycle: T3 and T4
        if angle >= (math.pi + alpha_rad) and angle < (2 * math.pi):
            signals['T3'] = True
            signals['T4'] = True
        else:
            signals['T3'] = False
            signals['T4'] = False
            
        return signals
    return get_signals

@app.post("/api/simulate")
def simulate(req: SimulationRequest):
    try:
        # Construct circuit JSON for Full-Bridge Thyristor with RL Load
        v_peak = req.v_rms * math.sqrt(2)
        circuit_json = {
            "simulation": { "t_end": 0.04, "dt": 2e-5 },
            "components": [
                { "type": "V_AC", "id": "V1", "nodes": ["n_a", "n_b"], "amplitude": v_peak, "freq": 50 },
                
                # Full bridge
                { "type": "Thyristor", "id": "T1", "nodes": ["n_a", "dc_p"] },
                { "type": "Thyristor", "id": "T4", "nodes": ["n_a", "gnd"] },
                { "type": "Thyristor", "id": "T3", "nodes": ["n_b", "dc_p"] },
                { "type": "Thyristor", "id": "T2", "nodes": ["n_b", "gnd"] },
                
                # Load (R and L in series). If L=0, just use small L or pure R.
                { "type": "Inductor", "id": "L1", "nodes": ["dc_p", "load_mid"], "value": max(req.l_val, 1e-6) },
                { "type": "Resistor", "id": "R1", "nodes": ["load_mid", "gnd"], "value": max(req.r_val, 1e-3) }
            ]
        }
        
        sim, sim_params = build_from_json(circuit_json)
        gate_func = get_gate_signals_func(req.alpha, freq=50.0)
        
        results = sim.run(t_end=sim_params['t_end'], dt=sim_params['dt'], get_gate_signals=gate_func)
        
        # Calculate load current and load voltage
        v_load = results['nodes']['dc_p'] # Since dc_n is gnd
        i_load = results['nodes']['load_mid'] / req.r_val # Current through resistor
        v_source = results['nodes']['n_a'] - results['nodes']['n_b']
        
        avg_v = sum(v_load) / len(v_load)
        avg_i = sum(i_load) / len(i_load)
        
        return {
            "time": results['time'].tolist(),
            "v_source": v_source.tolist(),
            "v_load": v_load.tolist(),
            "i_load": i_load.tolist(),
            "metrics": {
                "avg_v": round(avg_v, 2),
                "avg_i": round(avg_i, 2),
                "power": round(avg_v * avg_i, 2)
            }
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

class CustomSimulationRequest(BaseModel):
    circuit_json: dict

def compute_circuit_stats(nodes, branch_i, branch_v, branch_p, idx=slice(None)):
    stats = {}
    
    # Node statistics
    for node, v_arr in nodes.items():
        if len(v_arr) > 0:
            v_sub = v_arr[idx]
            if len(v_sub) == 0:
                v_sub = v_arr
            v_avg = float(np.mean(v_sub))
            v_rms = float(np.sqrt(np.mean(v_sub**2)))
            v_rf = float(np.sqrt(max(0.0, (v_rms / abs(v_avg))**2 - 1.0))) if abs(v_avg) > 1e-6 else 0.0
            stats[f"V({node})"] = {
                "avg": round(v_avg, 2),
                "rms": round(v_rms, 2),
                "pk_pk": round(float(np.ptp(v_sub)), 2),
                "max": round(float(np.max(v_sub)), 2),
                "min": round(float(np.min(v_sub)), 2),
                "rf": round(v_rf, 3)
            }
            
    # Branch statistics
    for comp_name, i_arr in branch_i.items():
        v_arr = branch_v.get(comp_name, np.zeros_like(i_arr))
        p_arr = branch_p.get(comp_name, np.zeros_like(i_arr))
        if len(i_arr) > 0:
            i_sub = i_arr[idx]
            p_sub = p_arr[idx]
            if len(i_sub) == 0:
                i_sub = i_arr
                p_sub = p_arr
            i_avg = float(np.mean(i_sub))
            i_rms = float(np.sqrt(np.mean(i_sub**2)))
            i_rf = float(np.sqrt(max(0.0, (i_rms / abs(i_avg))**2 - 1.0))) if abs(i_avg) > 1e-6 else 0.0
            p_avg = float(np.mean(p_sub))
            stats[f"I({comp_name})"] = {
                "avg": round(i_avg, 3),
                "rms": round(i_rms, 3),
                "pk_pk": round(float(np.ptp(i_sub)), 3),
                "max": round(float(np.max(i_sub)), 3),
                "min": round(float(np.min(i_sub)), 3),
                "p_avg": round(p_avg, 2),
                "power": round(p_avg, 2),
                "rf": round(i_rf, 3)
            }

    return stats

@app.post("/api/simulate_custom")
def simulate_custom(req: CustomSimulationRequest):
    try:
        sim, sim_params = build_from_json(req.circuit_json)
        
        t_end = float(sim_params.get('t_end', 0.04))
        dt = float(sim_params.get('dt', 1e-5))
        
        gate_signals_map = req.circuit_json.get("control", {})

        # Identify fundamental frequency freq
        freq = None
        if "freq" in sim_params and sim_params["freq"] is not None:
            try:
                freq = float(sim_params["freq"])
            except (ValueError, TypeError):
                pass
                
        if not freq or freq <= 0:
            for comp in req.circuit_json.get("components", []):
                if comp.get("type") == "V_AC" and "freq" in comp:
                    try:
                        f_candidate = float(comp["freq"])
                        if f_candidate > 0:
                            freq = f_candidate
                            break
                    except (ValueError, TypeError):
                        pass
                        
        if not freq or freq <= 0:
            for ctrl in gate_signals_map.values():
                if "freq" in ctrl:
                    try:
                        f_candidate = float(ctrl["freq"])
                        if f_candidate > 0:
                            freq = f_candidate
                            break
                    except (ValueError, TypeError):
                        pass
                        
        if not freq or freq <= 0:
            freq = 50.0

        T_cycle = 1.0 / freq
        t_steady_start = max(0.0, t_end - T_cycle)
        t_steady_end = t_end
        
        def gate_func(t):
            signals = {}
            for comp_id, ctrl in gate_signals_map.items():
                ctype = ctrl.get('type', 'pulse')
                c_freq = max(ctrl.get('freq', 50.0), 1e-3)
                period = 1.0 / c_freq
                
                if ctype == 'pulse':
                    delay_angle = ctrl.get('delay_angle', 0.0)
                    pulse_width = ctrl.get('width', 15.0) # degrees
                    
                    omega = 2 * math.pi * c_freq
                    t_c = t % period
                    angle = (omega * t_c * 180.0 / math.pi) % 360.0
                    
                    end_angle = (delay_angle + pulse_width) % 360.0
                    if delay_angle + pulse_width <= 360.0:
                        signals[comp_id] = (angle >= delay_angle and angle <= delay_angle + pulse_width)
                    else:
                        signals[comp_id] = (angle >= delay_angle or angle <= end_angle)
                        
                elif ctype == 'pwm':
                    duty = ctrl.get('duty', 50.0) # 0 to 100%
                    phase = ctrl.get('phase', 0.0) # degrees
                    t_offset = (phase / 360.0) * period
                    t_c = (t + t_offset) % period
                    on_time = (duty / 100.0) * period
                    signals[comp_id] = (t_c <= on_time)
                    
                elif ctype == 'constant':
                    signals[comp_id] = bool(ctrl.get('state', True))
                else:
                    signals[comp_id] = False
            return signals

        results = sim.run(t_end=t_end, dt=dt, get_gate_signals=gate_func)
        
        # Calculate summary statistics
        time_arr = results['time']
        
        # Determine steady-state slice indices
        idx_steady = np.where(time_arr >= (t_steady_start - 1e-9))[0]
        if len(idx_steady) == 0:
            idx_steady = slice(None)
            
        stats_steady = compute_circuit_stats(results['nodes'], results['branch_i'], results['branch_v'], results['branch_p'], idx_steady)
        stats_transient = compute_circuit_stats(results['nodes'], results['branch_i'], results['branch_v'], results['branch_p'], slice(None))

        json_results = {
            "time": time_arr.tolist(),
            "nodes": {k: v.tolist() for k, v in results['nodes'].items()},
            "branch_i": {k: v.tolist() for k, v in results['branch_i'].items()},
            "branch_v": {k: v.tolist() for k, v in results['branch_v'].items()},
            "branch_p": {k: v.tolist() for k, v in results['branch_p'].items()},
            "switches": {k: v.tolist() for k, v in results.get('switches', {}).items()},
            "steady_window": {
                "t_start": float(t_steady_start),
                "t_end": float(t_steady_end),
                "cycle_period": float(T_cycle)
            },
            "stats_steady": stats_steady,
            "stats_transient": stats_transient,
            "stats": stats_steady
        }
        
        return json_results
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

from fastapi.responses import RedirectResponse

@app.get("/")
def root():
    return RedirectResponse(url="/builder.html")

app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
