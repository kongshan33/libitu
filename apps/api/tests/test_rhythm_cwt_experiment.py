"""Offline experiment tests. Run explicitly with its optional PyWavelets env."""
from copy import deepcopy

import pytest

# PyWavelets is deliberately absent from the application dependencies.
pytest.importorskip("pywt")
import numpy as np
from scripts.rhythm_cwt import analyze, cached_reference, _wavelet


def fixture():
    return {"alignment": {"status": "aligned",
        "words": [{"start_sec": i*.5, "end_sec": (i+1)*.5, "label": str(i)} for i in range(8)],
        "phones": [{"start_sec": i*.5, "end_sec": (i+1)*.5, "label": "AH0"} for i in range(8)]},
        "measurements": {"duration_sec": 4., "quality_issues": [], "pauses": [],
            "frames": [{"time_sec": i*.01, "f0_hz": 150., "energy_dbfs": -25.} for i in range(400)]}}


def scores(sample):
    return np.array([w["relative_prominence"] for w in analyze(sample)["words"]])


def test_flat_speech_is_not_forced_to_have_a_prominent_word():
    assert np.max(scores(fixture())) < 1e-9


def test_gain_and_global_pitch_shift_do_not_change_relative_prominence():
    sample = fixture()
    for frame in sample["measurements"]["frames"]:
        bump = np.exp(-((frame["time_sec"]-1.75)/.12)**2)
        frame["energy_dbfs"] += 8*bump
        frame["f0_hz"] *= 2**(4*bump/12)
    shifted = deepcopy(sample)
    for frame in shifted["measurements"]["frames"]:
        frame["energy_dbfs"] -= 12
        frame["f0_hz"] *= 1.4
    np.testing.assert_allclose(scores(sample), scores(shifted), atol=1e-10)
    assert np.argmax(scores(sample)) == 3  # known controlled acoustic bump, not gold stress


def test_missing_pitch_is_uncertain_not_a_weak_stress_label():
    sample = fixture()
    for frame in sample["measurements"]["frames"]:
        frame["f0_hz"] = None
    result = analyze(sample)
    assert all(w["status"] == "uncertain" and "low_pitch_coverage" in w["reasons"] for w in result["words"])
    assert not any(result["curves"]["pitch_support"])


def test_long_unvoiced_gap_is_not_interpolated():
    sample = fixture()
    for frame in sample["measurements"]["frames"][100:160]:
        frame["f0_hz"] = None
    assert not any(analyze(sample)["curves"]["pitch_support"][100:160])


def test_missing_phone_coverage_abstains():
    sample = fixture()
    sample["alignment"]["phones"] = sample["alignment"]["phones"][1:]
    word = analyze(sample)["words"][0]
    assert word["relative_prominence"] is None and word["status"] == "uncertain"


@pytest.mark.parametrize("mutation", ["irregular", "nonfinite", "offset", "overlap"])
def test_invalid_timing_and_features_rejected(mutation):
    sample = fixture()
    if mutation == "irregular":
        sample["measurements"]["frames"][30]["time_sec"] += .001
    elif mutation == "nonfinite":
        sample["measurements"]["frames"][30]["energy_dbfs"] = float("nan")
    elif mutation == "offset":
        for f in sample["measurements"]["frames"]:
            f["time_sec"] += 10
    else:
        sample["alignment"]["words"][1]["start_sec"] = .2
    with pytest.raises(ValueError):
        analyze(sample)


def test_bad_audio_quality_abstains():
    sample = fixture()
    sample["measurements"]["quality_issues"] = ["clipping"]
    assert analyze(sample)["words"] == []


def test_fft_cwt_matches_direct_convolution():
    import pywt
    from scripts.rhythm_cwt import SCALES_SEC, DT
    signal = np.sin(np.arange(400)*.1)
    scales = SCALES_SEC/DT
    pad = int(np.ceil(scales[-1]*8))
    direct, _ = pywt.cwt(np.pad(signal,pad,mode="reflect"), scales,"mexh", sampling_period=DT,method="conv")
    np.testing.assert_allclose(_wavelet(signal), direct[:,pad:-pad]/np.sqrt(scales[:,None]),atol=1e-12)


def test_cache_reuses_exact_reference_and_invalidates_changes(tmp_path):
    sample = fixture()
    _, hit = cached_reference(sample,tmp_path,identity={"reference":"a","owner":"one"})
    assert not hit
    _, hit = cached_reference(sample,tmp_path,identity={"reference":"a","owner":"one"})
    assert hit
    _, hit = cached_reference(sample,tmp_path,identity={"reference":"a","owner":"two"})
    assert not hit
    sample["measurements"]["frames"][170]["energy_dbfs"] += 6
    _, hit = cached_reference(sample,tmp_path,identity={"reference":"a","owner":"one"})
    assert not hit
