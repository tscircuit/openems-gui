import json, sys, math
r = json.load(open(sys.argv[1] + "/results.json"))
f = r["freq"]; n = len(f)
def db(c, i): return 20*math.log10(max(1e-12, math.hypot(c["re"][i], c["im"][i])))
keys = sorted(r["s"].keys())
print("f(GHz)  " + "  ".join("S%s" % k.replace("_", "") for k in keys) + "   Zin")
for i in range(0, n, max(1, n // 16)):
    z = r["zin"][str(r["excited"][0])]
    print("%6.3f  " % (f[i] / 1e9) + "  ".join("%6.2f" % db(r["s"][k], i) for k in keys) + "   %6.1f%+6.1fj" % (z["re"][i], z["im"][i]))
if r.get("nf2ff"): print({k: {kk: vv for kk, vv in v.items() if kk in ("freq", "dmax_dbi", "efficiency")} for k, v in r["nf2ff"].items()})
print(r["runs"])
