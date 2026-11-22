#!/usr/bin/env python3
"""
openEMS runner for openems-gui.

    python3 run_sim.py <job_dir>            # simulate
    python3 run_sim.py <job_dir> --mesh     # only build the FDTD grid and report on it

Reads <job_dir>/sim.json (written by the GUI, see src/lib/types.ts SimInput),
runs one FDTD simulation per excited port and writes <job_dir>/results.json.
Field dumps requested in sim.json are converted to compact fields_p<port>_<name>.bin files.
With --mesh, openEMS only sets up its operator (no time-stepping) and the metal edges it
actually placed on the grid are written to <job_dir>/pec.bin for the mesh preview.
Lines starting with "@@EVENT " on stdout are machine readable progress events.
"""
import base64
import json
import os
import re
import sys
import time
import traceback
import zlib

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

    for d in sim.get("dumps", []):
        # E: cell interpolation (node interpolation is wrong for the normal field on metal),
        # H: node interpolation (the same caveat, the other way round)
        kw = {"dump_type": DUMP_TYPE[(d["quantity"], d["domain"])], "dump_mode": 2 if d["quantity"] == "E" else 1, "file_type": 1}
        if d["domain"] == "freq":
            kw["frequency"] = [float(f) for f in d["freqs"]]
        sub = [max(1, int(v)) for v in d.get("sub", [1, 1, 1])]
        if max(sub) > 1:
            kw["sub_sampling"] = sub
        CSX.AddDump(d["name"], **kw).AddBox(d["start"], d["stop"])

    nf2ff = None
    if sim["nf2ff"]["enabled"]:
        nf2ff = FDTD.CreateNF2FFBox()
    return FDTD, CSX, ports, nf2ff


DUMP_TYPE = {("E", "time"): 0, ("H", "time"): 1, ("E", "freq"): 10, ("H", "freq"): 11}


def convert_dump(h5_path, dump, out_path, unit):
    """
    Rewrites an openEMS HDF5 field dump as little-endian int16, laid out as
    [frame][component][z][y][x] with value = int16 * scale. Frequency-domain dumps have six
    components per frame (Re Fx, Im Fx, Re Fy, Im Fy, Re Fz, Im Fz), time-domain dumps three.
    """
    import h5py

    with h5py.File(h5_path, "r") as f:
        axes = [np.asarray(f["Mesh/" + a][()], dtype=float) / unit for a in "xyz"]  # metres -> drawing units
        frames = []
        if dump["domain"] == "freq":
            fd = f["FieldData/FD"]
            freqs = [float(v) for v in np.atleast_1d(fd.attrs["frequency"])]
            blocks = []
            for i, fr in enumerate(freqs):
                if "f%d" % i in fd:
                    a = np.asarray(fd["f%d" % i][()])
                else:  # older openEMS: separate real / imaginary datasets
                    a = np.asarray(fd["f%d_real" % i][()]) + 1j * np.asarray(fd["f%d_imag" % i][()])
                blocks.append(np.stack([a.real, a.imag], axis=1).reshape((6,) + a.shape[1:]))
                frames.append({"f": fr})
            components = 6
        else:
            td = f["FieldData/TD"]
            names = sorted(td.keys())
            peaks = np.array([float(np.nanmax(np.abs(td[n][()]))) for n in names])
            if not len(names) or not np.isfinite(peaks).all() or peaks.max() <= 0:
                raise RuntimeError("the time-domain dump is empty")
            # keep the part of the run in which something is still happening
            alive = int(np.nonzero(peaks > 0.02 * peaks.max())[0][-1])
            last = min(len(names) - 1, alive + 2)
            step = int(np.ceil((last + 1) / float(max(2, int(dump.get("max_frames", 120))))))
            blocks = []
            for n in names[: last + 1 : step]:
                blocks.append(np.asarray(td[n][()], dtype=np.float32))
                frames.append({"t": float(np.atleast_1d(td[n].attrs["time"])[0])})
            components = 3
    data = np.stack(blocks).astype(np.float32)  # (frame, component, x, y, z)
    data = np.where(np.isfinite(data), data, 0)
    data = data.transpose(0, 1, 4, 3, 2)  # -> (frame, component, z, y, x)
    peak = float(np.max(np.abs(data)))
    scale = peak / 32767.0 if peak > 0 else 1.0
    np.round(data / scale).astype("<i2").tofile(out_path)
    return {
        "name": dump["name"],
        "quantity": dump["quantity"],
        "domain": dump["domain"],
        "file": os.path.basename(out_path),
        "x": [round(float(v), 5) for v in axes[0]],
        "y": [round(float(v), 5) for v in axes[1]],
        "z": [round(float(v), 5) for v in axes[2]],
        "frames": frames,
        "components": components,
        "scale": scale,
    }


def export_dumps(sim, sim_path, job_dir, port):
    out = []
    for d in sim.get("dumps", []):
        h5_path = os.path.join(sim_path, d["name"] + ".h5")
        if not os.path.exists(h5_path):
            continue
        try:
            out.append(convert_dump(h5_path, d, os.path.join(job_dir, "fields_p%d_%s.bin" % (port, d["name"])), sim["unit"]))
        except Exception as err:
            traceback.print_exc()
            emit("warning", message="Could not read the %s field dump: %s" % (d["name"], err))
        finally:
            os.remove(h5_path)  # these can be hundreds of MB
    return out


def read_vtp_lines(path):
    """Points (n, 3) and line connectivity (m, 2) of a VTK .vtp file with appended (raw or base64, optionally zlib) data."""
    raw = open(path, "rb").read()
    head_end = raw.index(b"<AppendedData")
    tag_end = raw.index(b">", head_end)
    xml = raw[:head_end].decode("ascii", "replace")
    base = raw.index(b"_", tag_end) + 1
    b64 = b"base64" in raw[head_end:tag_end]
    compressed = "vtkZLibDataCompressor" in xml
    head = "<u8" if 'header_type="UInt64"' in xml else "<u4"
    hsize = np.dtype(head).itemsize

    def take(pos, nbytes):
        """nbytes of payload starting at stream position pos -> (bytes, next position)."""
        if not b64:
            return raw[pos : pos + nbytes], pos + nbytes
        chars = 4 * ((nbytes + 2) // 3)  # every header / data block is its own base64 unit
        return base64.b64decode(raw[pos : pos + chars])[:nbytes], pos + chars

    def array(section, name):
        block = re.search(r"<%s>(.*?)</%s>" % (section, section), xml, re.S).group(1)
        for tag in re.findall(r"<DataArray[^>]*>", block):
            if 'Name="%s"' % name not in tag:
                continue
            dtype = {"Float32": "<f4", "Float64": "<f8", "Int64": "<i8", "Int32": "<i4"}[re.search(r'type="(\w+)"', tag).group(1)]
            pos = base + int(re.search(r'offset="(\d+)"', tag).group(1))
            if not compressed:
                n = int(np.frombuffer(take(pos, hsize)[0], head)[0])
                return np.frombuffer(take(pos, hsize + n)[0][hsize:], dtype)
            nblocks = int(np.frombuffer(take(pos, hsize)[0], head)[0])
            header, pos = take(pos, hsize * (3 + nblocks))
            sizes = [int(v) for v in np.frombuffer(header, head)[3:]]
            data = take(pos, sum(sizes))[0]
            chunks, at = [], 0
            for size in sizes:
                chunks.append(zlib.decompress(data[at : at + size]))
                at += size
            return np.frombuffer(b"".join(chunks), dtype)
        raise KeyError(name)

    points = array("Points", "Points").reshape(-1, 3)
    conn = array("Lines", "connectivity").reshape(-1, 2)
    return points, conn


def mesh_only(job_dir, sim, capabilities):
    """Builds the FDTD operator without time-stepping and exports the metal edges it contains."""
    excited = [p["number"] for p in sim["ports"] if p["excite"]] or [p["number"] for p in sim["ports"]] or [0]
    sim = dict(sim, copper=dict(sim["copper"], model="pec"), dumps=[], nf2ff={"enabled": False, "freq": 0})
    FDTD, CSX, _ports, _nf2ff = build(sim, excited[0], capabilities)
    sim_path = os.path.join(job_dir, "setup")
    os.makedirs(sim_path, exist_ok=True)
    emit("mesh_start")
    t0 = time.time()
    FDTD.Run(sim_path, cleanup=True, setup_only=True, debug_PEC=True, verbose=1)
    seconds = time.time() - t0
    info = {"seconds": seconds, "points": 0, "edges": 0}
    vtp = os.path.join(sim_path, "PEC_dump.vtp")
    if os.path.exists(vtp):
        points, conn = read_vtp_lines(vtp)
        info["points"], info["edges"] = int(len(points)), int(len(conn))
        with open(os.path.join(job_dir, "pec.bin"), "wb") as fh:
            (points / sim["unit"]).astype("<f4").tofile(fh)  # metres -> drawing units
            conn.astype("<u4").tofile(fh)
    with open(os.path.join(job_dir, "mesh.json"), "w") as fh:
        json.dump(info, fh)
    emit("mesh_done", **info)


def main():
    job_dir = os.path.abspath(sys.argv[1])
    with open(os.path.join(job_dir, "sim.json")) as fh:
        sim = json.load(fh)

    capabilities = detect_capabilities()
    if "--mesh" in sys.argv[2:]:
        mesh_only(job_dir, sim, capabilities)
        emit("done")
        return
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
        "fields": {},
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

        if sim.get("dumps"):
            emit("fields_start", port=ex)
            fields = export_dumps(sim, sim_path, job_dir, ex)
            if fields:
                results["fields"][str(ex)] = fields

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
                # full sphere for the 3D pattern view
                theta3 = np.arange(0.0, 180.1, 6.0)
                phi3 = np.arange(0.0, 360.1, 10.0)
                ff3 = nf2ff.CalcNF2FF(sim_path, f_ff, theta3, phi3, center=center, outfile="nf2ff_3d.h5")
                e3 = np.asarray(ff3.E_norm[0])
                with np.errstate(divide="ignore"):
                    d3 = 20.0 * np.log10(e3 / np.max(e3)) + 10.0 * np.log10(float(np.asarray(ff3.Dmax).ravel()[0]))
                results["nf2ff"][str(ex)]["pattern"] = {
                    "theta": [float(t) for t in theta3],
                    "phi": [float(p) for p in phi3],
                    "d_dbi": [[round(float(v), 2) for v in row] for row in np.maximum(d3, -60.0)],
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
