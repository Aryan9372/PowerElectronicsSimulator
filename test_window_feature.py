import sys
from app import simulate_custom, CustomSimulationRequest

def test_transient_window_and_duration():
    print("=== TEST 1: Custom Duration 0.5s with Window 0.0s to 0.1s ===")
    circuit_json = {
        'simulation': {
            't_end': 0.5,
            'dt': 5e-5,
            'window': {
                't_start': 0.0,
                't_end': 0.1
            }
        },
        'components': [
            {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'gnd'], 'amplitude': 100.0, 'freq': 50},
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['n_a', 'gnd'], 'value': 10.0}
        ]
    }

    req = CustomSimulationRequest(circuit_json=circuit_json)
    res = simulate_custom(req)

    print(f"Time points: {len(res['time'])}, Max time: {max(res['time']):.4f}s")
    assert 'stats_window' in res, "stats_window missing from response"
    assert 'stats_steady' in res, "stats_steady missing from response"
    assert 'stats_transient' in res, "stats_transient missing from response"
    assert res['stats_window'] is not None, "stats_window should not be None"

    print("stats_window V(n_a):", res['stats_window'].get('V(n_a)'))
    print("stats_steady V(n_a):", res['stats_steady'].get('V(n_a)'))
    print("stats_transient V(n_a):", res['stats_transient'].get('V(n_a)'))
    print("window metadata:", res.get('window'))

    assert res['window']['t_start'] == 0.0
    assert res['window']['t_end'] == 0.1
    assert 'avg' in res['stats_window']['V(n_a)']
    assert 'rms' in res['stats_window']['V(n_a)']

    print("=== TEST 2: Auto-extension of t_end ===")
    circuit_json_ext = {
        'simulation': {
            't_end': 0.04,
            'dt': 5e-5,
            'window': {
                't_start': 0.0,
                't_end': 0.2
            }
        },
        'components': [
            {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'gnd'], 'amplitude': 100.0, 'freq': 50},
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['n_a', 'gnd'], 'value': 10.0}
        ]
    }
    res_ext = simulate_custom(CustomSimulationRequest(circuit_json=circuit_json_ext))
    max_t = max(res_ext['time'])
    print(f"Original t_end=0.04, Window t_end=0.2 => Solved max time: {max_t:.4f}s")
    assert max_t >= 0.199, f"Expected t_end to auto-extend to at least 0.2s, got {max_t}"
    assert res_ext['stats_window'] is not None

    print("=== TEST 3: Arbitrary Durations (0.05s, 0.1s, 0.5s, 1.0s, 2.0s) ===")
    for dur in [0.05, 0.1, 0.5, 1.0, 2.0]:
        dt = 1e-4 if dur >= 1.0 else 5e-5
        c_json = {
            'simulation': {'t_end': dur, 'dt': dt},
            'components': [
                {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'gnd'], 'amplitude': 50.0, 'freq': 50},
                {'type': 'Resistor', 'id': 'R1', 'nodes': ['n_a', 'gnd'], 'value': 25.0}
            ]
        }
        res_dur = simulate_custom(CustomSimulationRequest(circuit_json=c_json))
        m_t = max(res_dur['time'])
        print(f"Requested dur={dur}s => Max time={m_t:.4f}s, steps={len(res_dur['time'])}")
        assert abs(m_t - (dur - dt)) < 1e-4 or abs(m_t - dur) < 1e-4

    print("=== TEST 4: Without Window parameter (stats_window is None) ===")
    c_json_no_win = {
        'simulation': {'t_end': 0.04, 'dt': 5e-5},
        'components': [
            {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'gnd'], 'amplitude': 50.0, 'freq': 50},
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['n_a', 'gnd'], 'value': 25.0}
        ]
    }
    res_no_win = simulate_custom(CustomSimulationRequest(circuit_json=c_json_no_win))
    assert res_no_win['stats_window'] is None, "stats_window should be None when window is omitted"
    assert res_no_win['stats_steady'] is not None
    assert res_no_win['stats_transient'] is not None
    print("stats_window correctly None when omitted.")

    print("\n>>> ALL TESTS PASSED SUCCESSFULLY! <<<")

if __name__ == '__main__':
    test_transient_window_and_duration()
