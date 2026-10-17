"""Time and plot the independent offline CWT experiment from saved features.

Inputs: JSON array of objects containing id, role, alignment and measurements.
Do not put private inputs in Git. Output contains word measurements; review
its destination and use a private directory for private learner speech.
"""
import argparse
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import platform
import subprocess
import sys
from time import perf_counter

import numpy as np
import pywt

from scripts.rhythm_cwt import analyze, cached_reference, VERSION


def stats(values):
    return {"n": len(values), "p50_ms": float(np.median(values)),
            "p95_ms": float(np.percentile(values, 95)), "min_ms": min(values), "max_ms": max(values)}


def timed(call, repeats):
    values = []
    for _ in range(repeats):
        tick = perf_counter()
        call()
        values.append((perf_counter()-tick)*1000)
    return stats(values)


def plots(samples, results, output):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
    for sample, result in zip(samples, results):
        if not result["words"]:
            continue
        curves, words = result.pop("curves"), result["words"]
        if sample.get("timing_only"):
            continue
        fig, axs = plt.subplots(3, 1, figsize=(12, 8), layout="constrained", gridspec_kw={"height_ratios":[1,1,1.3]})
        fig.suptitle(f"{sample['id']} | {sample['role']} | {result['duration_sec']:.2f}s\n"
                     "Relative acoustic prominence — experimental; no human stress labels", fontsize=14)
        t = curves["time_sec"]
        for feature, name in zip(curves["normalized_features"], ["F0 (gaps neutral)","Energy","Vowel duration"]):
            axs[0].plot(t, feature, label=name, linewidth=1.2)
        axs[0].set_ylabel("Normalized feature")
        axs[0].set_xlim(0,result["duration_sec"])
        axs[0].legend(loc="upper right", ncol=3, fontsize=8)
        bound = max(float(np.max(np.abs(curves["cwt"]))),1e-9)
        axs[1].imshow(curves["cwt"],aspect="auto",origin="lower",extent=[0,result["duration_sec"],0,12],cmap="RdBu_r",vmin=-bound,vmax=bound)
        axs[1].set_ylabel("CWT scale index\n60–240 ms, log spaced")
        axs[1].set_xlabel("Time (seconds)")
        xs = np.arange(len(words))
        axs[2].bar(xs, [w["relative_prominence"] or 0 for w in words],
                   color=["#e3c59b" if w["status"]=="uncertain" else "#466caf" for w in words])
        axs[2].set_xticks(xs,[w["text"]+(" ?" if w["status"]=="uncertain" else "") for w in words],rotation=35,ha="right")
        axs[2].set_ylabel("Relative prominence\n(arbitrary units; not %)")
        axs[2].set_xlabel("? = limited evidence / edge uncertainty; bars are not strong/weak classes")
        path = output / f"{sample['id']}.png"
        fig.savefig(path,dpi=150)
        plt.close(fig)
        result["plot"] = path.name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs",type=Path)
    parser.add_argument("--output-dir",type=Path,required=True)
    parser.add_argument("--cache-dir",type=Path,required=True)
    parser.add_argument("--repeats",type=int,default=100)
    parser.add_argument("--cold-only",action="store_true")
    args = parser.parse_args()
    samples = json.loads(args.inputs.read_text())
    if args.cold_only:
        for sample in samples:
            analyze(sample)
        return
    if args.repeats < 20:
        parser.error("Use at least 20 repeats")
    args.output_dir.mkdir(parents=True,exist_ok=True)
    results = []
    for sample in samples:
        tick = perf_counter()
        result = analyze(sample)
        first_ms = (perf_counter()-tick)*1000
        result.update({"id":sample["id"],"role":sample["role"],"first_call_ms":first_ms,
                       "timing_only":sample.get("timing_only",False),
                       "warm":timed(lambda:analyze(sample),args.repeats),
                       "preparation_timings":sample.get("timings",{}),
                       "input_sha256":sha256(json.dumps(sample,sort_keys=True).encode()).hexdigest()})
        if result["words"]:
            shifted = deepcopy(sample)
            for f in shifted["measurements"]["frames"]:
                f["energy_dbfs"] -= 12
                if f["f0_hz"] is not None:
                    f["f0_hz"] *= 1.4
            altered = analyze(shifted)
            result["gain_pitch_invariance_max_delta"] = max(abs(a["relative_prominence"]-b["relative_prominence"])
                for a,b in zip(result["words"],altered["words"]) if a["relative_prominence"] is not None)
            no_duration = analyze(sample,np.array([.5,.5,0.]))
            result["duration_ablation"] = {"description":"F0/energy only, weights .5/.5; uncalibrated sensitivity check",
                "words":[{"text":w["text"],"relative_prominence":w["relative_prominence"]} for w in no_duration["words"]]}
        if sample["role"]=="reference":
            identity = sample.get("cache_identity", {"dataset":"public-seed", "id":sample["id"]})
            tick=perf_counter()
            _,hit = cached_reference(sample,args.cache_dir,identity=identity)
            result["initial_cache_hit"]=hit
            result["cache_first_ms"]=(perf_counter()-tick)*1000
            result["cache_read"]=timed(lambda:cached_reference(sample,args.cache_dir,identity=identity),args.repeats)
        results.append(result)
    # Process startup + imports + JSON read + all samples, separate from warm compute.
    command=[sys.executable,"-m","scripts.benchmark_rhythm_cwt",str(args.inputs),
             "--output-dir",str(args.output_dir),"--cache-dir",str(args.cache_dir),"--cold-only"]
    cold=timed(lambda:subprocess.run(command,check=True,stdout=subprocess.DEVNULL),5)
    plots(samples,results,args.output_dir)
    report={"version":VERSION,"platform":platform.platform(),"python":platform.python_version(),
            "numpy":np.__version__,"pywavelets":pywt.__version__,
            "implementation_sha256":sha256(Path(__file__).with_name("rhythm_cwt.py").read_bytes()).hexdigest(),
            "timing_scope":"feature conversion, normalization, CWT, word aggregation, result serialization to lists; no ASR/MFA/network/UI/disk write",
            "cold_process_all_samples":cold,"samples":results,"paired_user_take_available":False,
            "gold_labels":0,"accuracy":None,"release_ready":False}
    (args.output_dir/"results.json").write_text(json.dumps(report,indent=2,allow_nan=False))
    print(json.dumps({"cold_process_all_samples":cold,"samples":[{"id":r["id"],"warm":r["warm"]} for r in results]},indent=2))


if __name__=="__main__":
    main()
