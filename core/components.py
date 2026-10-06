# core/components.py
class Component:
    def __init__(self, name, n1, n2):
        self.name = name
        self.n1 = n1
        self.n2 = n2

class Resistor(Component):
    def __init__(self, name, n1, n2, value):
        super().__init__(name, n1, n2)
        self.value = value

class Capacitor(Component):
    def __init__(self, name, n1, n2, value, v0=0.0):
        super().__init__(name, n1, n2)
        self.value = value
        self.v0 = v0 # Initial voltage
        # Companion model parameters
        self.req = None
        self.ieq = None

class Inductor(Component):
    def __init__(self, name, n1, n2, value, i0=0.0):
        super().__init__(name, n1, n2)
        self.value = value
        self.i0 = i0 # Initial current
        # Companion model parameters
        self.req = None
        self.ieq = None

class VoltageSource(Component):
    def __init__(self, name, n1, n2, vtype='dc', value=0.0, amplitude=0.0, freq=50.0, phase=0.0):
        super().__init__(name, n1, n2)
        self.vtype = vtype # 'dc' or 'ac'
        self.value = value # DC value
        self.amplitude = amplitude # AC peak amplitude
        self.freq = freq
        self.phase = phase

    def get_voltage(self, t):
        import math
        if self.vtype == 'dc':
            return self.value
        elif self.vtype == 'ac':
            return self.amplitude * math.sin(2 * math.pi * self.freq * t + self.phase)
        return 0.0

class Switch(Component):
    """Base class for Diode, Thyristor, MOSFET"""
    def __init__(self, name, n1, n2, ron=1e-4, roff=1e6):
        super().__init__(name, n1, n2)
        self.ron = ron
        self.roff = roff
        self.state = False # False = OFF, True = ON

    def get_resistance(self):
        return self.ron if self.state else self.roff

class Diode(Switch):
    def update_state(self, v_ak, i_ak):
        if not self.state:
            if v_ak > 0:
                self.state = True
        else:
            if i_ak <= 0:
                self.state = False

class Thyristor(Switch):
    def update_state(self, v_ak, i_ak, gate_signal):
        if not self.state:
            if v_ak > 0 and gate_signal:
                self.state = True
        else:
            if i_ak <= 0:
                self.state = False

class MOSFET(Switch):
    def __init__(self, name, n1, n2, ron=1e-4, roff=1e6, body_diode=True):
        super().__init__(name, n1, n2, ron, roff)
        self.body_diode = body_diode

    def update_state(self, v_ds, i_ds, gate_signal):
        # N-channel MOSFET: n1=Drain, n2=Source
        # Channel conducts in both directions when gate is ON
        if gate_signal:
            self.state = True
        else:
            # When gate is OFF, check body diode (Source to Drain, so v_ds < 0)
            if self.body_diode and v_ds < -1e-4:
                self.state = True
            elif self.body_diode and self.state and i_ds >= 0:
                # Body diode turns off when current through it stops (i_ds is D to S)
                self.state = False
            else:
                self.state = False

