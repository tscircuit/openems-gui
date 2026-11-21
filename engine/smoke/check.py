#!/usr/bin/env python3
"""Checks the results of the smoke job (a 50 ohm microstrip line with far field)."""
import json
import math
import sys

r = json.load(open(sys.argv[1]))
mid = len(r["freq"]) // 2
s21 = math.hypot(r["s"]["2_1"]["re"][mid], r["s"]["2_1"]["im"][mid])
s11 = math.hypot(r["s"]["1_1"]["re"][mid], r["s"]["1_1"]["im"][mid])
ff = r["nf2ff"]["1"]
print("smoke: |S21| = %.3f, |S11| = %.3f at %.2f GHz, Dmax = %.2f dBi" % (s21, s11, r["freq"][mid] / 1e9, ff["dmax_dbi"]))
assert 0.7 < s21 <= 1.01, "through-line transmission is wrong"
assert s11 < 0.4, "through-line reflection is wrong"
assert math.isfinite(ff["dmax_dbi"]) and -20 < ff["dmax_dbi"] < 20, "far field is wrong"
print("smoke: OK")
