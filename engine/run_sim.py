#!/usr/bin/env python3
"""
openEMS runner for openems-gui.

    python3 run_sim.py <job_dir>

Reads <job_dir>/sim.json (written by the GUI, see src/lib/types.ts SimInput),
runs one FDTD simulation per excited port and writes <job_dir>/results.json.
Lines starting with "@@EVENT " on stdout are machine readable progress events.
"""
import json
import os
import sys
import time
import traceback

import numpy as np


def emit(event, **data):
    print("@@EVENT " + json.dumps({"event": event, **data}), flush=True)


def cplx(a):
    a = np.asarray(a, dtype=complex)
    a = np.where(np.isfinite(a), a, 0)
    return {"re": [float(v) for v in a.real], "im": [float(v) for v in a.imag]}


DIR_INDEX = {"x": 0, "y": 1, "z": 2}


def add_lumped(CSX, el, capabilities):
    """Adds a resistor / capacitor / inductor between two points."""
    import inspect

    kind, value = el["kind"], el["value"]
    ny = DIR_INDEX[el["direction"]]
    kw = {}
    if kind == "R":
        kw["R"] = value
    elif kind == "C":
        kw["C"] = value
    elif kind == "L":
        if not capabilities["lumped_L"]:
            print(
                "WARNING: this openEMS build cannot model lumped inductors; %s (%.3g H) is left open."
                % (el["name"], value),
                flush=True,
            )
            emit("warning", message="Lumped inductor %s is not supported by this openEMS version and was left open. Use the source-built engine image." % el["name"])
            return
        kw["L"] = value
        kw["LEtype"] = 0  # parallel RLC with only L set -> plain inductor
    le = CSX.AddLumpedElement("lumped_" + el["name"], ny=ny, caps=True, **kw)
    le.AddBox(el["start"], el["stop"], priority=5)


def detect_capabilities():
    caps = {"lumped_L": False, "version": "unknown"}
    try:
        from CSXCAD import CSProperties

        caps["lumped_L"] = hasattr(CSProperties.CSPropLumpedElement, "SetLEtype")
    except Exception:
        pass
    try:
        import openEMS

        caps["version"] = getattr(openEMS, "__version__", "unknown")
    except Exception:
        pass
    return caps


def build(sim, excite_port, capabilities):
    from CSXCAD import ContinuousStructure
    from openEMS import openEMS

    f_start, f_stop = sim["f_start"], sim["f_stop"]
    f0 = 0.5 * (f_start + f_stop)
    fc = 0.5 * (f_stop - f_start)

    FDTD = openEMS(NrTS=int(sim["max_timesteps"]), EndCriteria=10 ** (sim["end_criteria_db"] / 10.0))
    FDTD.SetGaussExcite(f0, fc)
    FDTD.SetBoundaryCond(sim["boundaries"])

    CSX = ContinuousStructure()
    FDTD.SetCSX(CSX)
    mesh = CSX.GetGrid()
    mesh.SetDeltaUnit(sim["unit"])
    mesh.AddLine("x", sim["mesh"]["x"])
    mesh.AddLine("y", sim["mesh"]["y"])
    mesh.AddLine("z", sim["mesh"]["z"])

    sub = sim["substrate"]
    if sub["epsilon"] > 1.0 or sub["kappa"] > 0:
        substrate = CSX.AddMaterial("substrate", epsilon=sub["epsilon"], kappa=sub["kappa"])
        substrate.AddBox(sub["start"], sub["stop"], priority=1)

    cu = sim["copper"]
    if cu["model"] == "sheet":
        copper = CSX.AddConductingSheet("copper", conductivity=cu["conductivity"], thickness=cu["thickness_m"])
    else:
        copper = CSX.AddMetal("copper")
    for poly in sim["polygons"]:
        pts = np.asarray(poly["points"], dtype=float).T
        copper.AddPolygon(pts, "z", poly["z"], priority=10)

    if sim["vias"]:
        via_metal = CSX.AddMetal("via")
        for v in sim["vias"]:
            via_metal.AddCylinder([v["x"], v["y"], v["z0"]], [v["x"], v["y"], v["z1"]], v["radius"], priority=10)
            # a thin wire guarantees the barrel is meshed even when it is thinner than a cell
            via_metal.AddCurve([[v["x"], v["x"]], [v["y"], v["y"]], [v["z0"], v["z1"]]], priority=10)

    for el in sim["lumped"]:
        add_lumped(CSX, el, capabilities)

    ports = []
    for p in sim["ports"]:
        ports.append(
            FDTD.AddLumpedPort(
                p["number"],
                p["R"],
                p["start"],
                p["stop"],
                p["direction"],
                1.0 if p["number"] == excite_port else 0,
                priority=5,
            )
        )

    nf2ff = None
    if sim["nf2ff"]["enabled"]:
        nf2ff = FDTD.CreateNF2FFBox()
    return FDTD, CSX, ports, nf2ff


def main():
    job_dir = os.path.abspath(sys.argv[1])
    with open(os.path.join(job_dir, "sim.json")) as fh:
        sim = json.load(fh)

    capabilities = detect_capabilities()
    freq = np.linspace(max(sim["f_start"], 1.0), sim["f_stop"], int(sim["freq_points"]))
    excited = [p["number"] for p in sim["ports"] if p["excite"]]
    nx, ny, nz = (len(sim["mesh"][a]) for a in "xyz")
    cells = (nx - 1) * (ny - 1) * (nz - 1)
    emit("start", excited=excited, cells=cells, mesh=[nx, ny, nz], capabilities=capabilities)

    results = {
        "freq": [float(f) for f in freq],
        "ports": [{"number": p["number"], "name": p["name"], "R": p["R"]} for p in sim["ports"]],
        "s": {},
        "zin": {},
        "excited": [],
        "nf2ff": {},
        "runs": [],
    }

    def save():
        tmp = os.path.join(job_dir, "results.json.tmp")
        with open(tmp, "w") as fh:
            json.dump(results, fh)
        os.replace(tmp, os.path.join(job_dir, "results.json"))

    for idx, ex in enumerate(excited):
        emit("run_start", port=ex, index=idx, total=len(excited))
        FDTD, CSX, ports, nf2ff = build(sim, ex, capabilities)
        sim_path = os.path.join(job_dir, "run_port%d" % ex)
        os.makedirs(sim_path, exist_ok=True)
        if idx == 0:
            CSX.Write2XML(os.path.join(job_dir, "geometry.xml"))
        t0 = time.time()
        kw = {}
        if sim.get("threads", 0) > 0:
            kw["numThreads"] = int(sim["threads"])
        FDTD.Run(sim_path, cleanup=True, **kw)
        seconds = time.time() - t0

        for port, pdef in zip(ports, sim["ports"]):
            port.CalcPort(sim_path, freq, ref_impedance=pdef["R"])
        src = ports[[p["number"] for p in sim["ports"]].index(ex)]
        src_R = [p["R"] for p in sim["ports"] if p["number"] == ex][0]
        for port, pdef in zip(ports, sim["ports"]):
            s = (port.uf_ref / np.sqrt(pdef["R"])) / (src.uf_inc / np.sqrt(src_R))
            results["s"]["%d_%d" % (pdef["number"], ex)] = cplx(s)
        results["zin"][str(ex)] = cplx(src.uf_tot / src.if_tot)
        results["excited"].append(ex)

        results["runs"].append({"port": ex, "seconds": seconds, "cells": cells})

        if nf2ff is not None:
            try:
                emit("nf2ff_start", port=ex)
                s11 = np.abs(src.uf_ref / src.uf_inc)
                f_ff = sim["nf2ff"]["freq"]
                if not f_ff or f_ff <= 0:
                    f_ff = float(freq[int(np.argmin(s11))])
                theta = np.arange(-180.0, 181.0, 2.0)
                phi = np.array([0.0, 90.0])
                sub = sim["substrate"]
                center = [
                    0.5 * (sub["start"][0] + sub["stop"][0]) * sim["unit"],
                    0.5 * (sub["start"][1] + sub["stop"][1]) * sim["unit"],
                    0.5 * (sub["start"][2] + sub["stop"][2]) * sim["unit"],
                ]
                ff = nf2ff.CalcNF2FF(sim_path, f_ff, theta, phi, center=center)
                e = np.asarray(ff.E_norm[0])
                dmax = float(np.asarray(ff.Dmax).ravel()[0])
                with np.errstate(divide="ignore"):
                    d_dbi = 20.0 * np.log10(e / np.max(e)) + 10.0 * np.log10(dmax)
                d_dbi = np.maximum(d_dbi, -60.0)
                fi = int(np.argmin(np.abs(freq - f_ff)))
                p_acc = float(np.real(src.P_acc[fi]))
                prad = float(np.asarray(ff.Prad).ravel()[0])
                results["nf2ff"][str(ex)] = {
                    "freq": float(f_ff),
                    "dmax_dbi": float(10.0 * np.log10(dmax)),
                    "efficiency": float(prad / p_acc) if p_acc > 0 else 0.0,
                    "theta": [float(t) for t in theta],
                    "phi": [float(p) for p in phi],
                    "cut_xz": [float(v) for v in d_dbi[:, 0]],
                    "cut_yz": [float(v) for v in d_dbi[:, 1]],
                }
            except Exception as err:  # far field is optional; keep the S-parameters
                traceback.print_exc()
                emit("warning", message="Far-field calculation failed: %s" % err)

        save()
        emit("run_done", port=ex, index=idx, total=len(excited), seconds=seconds)

    emit("done")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        traceback.print_exc()
        emit("error", message=str(err))
        sys.exit(1)
