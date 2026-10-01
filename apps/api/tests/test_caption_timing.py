from dataclasses import asdict
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.integrations import youtube_transcript
from app.schemas.captions import CaptionTrack, CaptionWordTiming
from app.schemas.sentence import SentenceMetadata
from app.services.transcript_formatter import (
    caption_track_matches_text,
    caption_track_to_text,
    format_transcript,
    parse_caption_track,
    parse_transcript,
    timestamp_seconds,
)


def track(events, **overrides):
    return CaptionTrack.model_validate({
        "version": "youtube-json3-v1", "video_id": "test-video", "language": "en", "kind": "asr",
        "events": events, **overrides,
    })


def event(segments, start=1234, duration=2000, **overrides):
    return {"tStartMs": start, "dDurationMs": duration, "segs": segments, **overrides}


def format_track(value, **kwargs):
    return format_transcript(caption_track_to_text(value), "en", caption_track=value, syntax_engine=None, **kwargs)


def test_json3_preserves_raw_fields_and_millisecond_event_navigation():
    source = track([event([
        {"utf8": "We"}, {"utf8": " agree.", "tOffsetMs": 350},
    ], wWinId=1)])
    assert source.events[0].segs[0].tOffsetMs is None
    assert source.events[0].wWinId == 1
    assert caption_track_to_text(source) == "0:01.234\tWe agree."
    rows = format_track(source)
    assert rows[0].segmentation_version == "sentence-v3-source"
    assert rows[0].timing_source == "caption_word_offsets"
    assert rows[0].start_ms == 1234 and rows[0].end_ms == 3234
    assert [word.start_ms for word in rows[0].word_timings] == [1234, 1584]
    assert [word.end_source for word in rows[0].word_timings] == ["next_word_estimate", "event_end_estimate"]
    assert rows[0].word_timings[0].source_event_index == 0
    assert rows[0].word_timings[1].source_seg_index == 1
    SentenceMetadata.model_validate(rows[0].metadata())


@pytest.mark.parametrize("segments", [
    [{"utf8": "We agree.", "tOffsetMs": 0}],
    [{"utf8": "We"}, {"utf8": " agree."}],
    [{"utf8": "We", "tOffsetMs": 200}, {"utf8": " agree.", "tOffsetMs": 100}],
    [{"utf8": "We", "tOffsetMs": 0}, {"utf8": " agree.", "tOffsetMs": 0}],
    [{"utf8": "We", "tOffsetMs": -10}, {"utf8": " agree.", "tOffsetMs": 100}],
    [{"utf8": "We", "tOffsetMs": 0}, {"utf8": " agree.", "tOffsetMs": 2000}],
])
def test_block_missing_invalid_or_out_of_order_offsets_do_not_create_word_highlights(segments):
    source = track([event(segments)])
    rows = format_track(source)
    assert rows[0].text == "We agree."
    assert rows[0].word_timings is None
    assert rows[0].timing_source == "caption_event_estimate"
    assert (rows[0].start_ms, rows[0].end_ms) == (1234, 3234)


def test_valid_start_survives_missing_next_offset_or_end():
    source = track([event([
        {"utf8": "We", "tOffsetMs": 100}, {"utf8": " really"}, {"utf8": " agree.", "tOffsetMs": 700},
    ], duration=None)])
    rows = format_track(source)
    assert [word.source_token_index for word in rows[0].word_timings] == [0, 2]
    assert [word.start_ms for word in rows[0].word_timings] == [1334, 1934]
    assert all(word.end_ms is None and word.end_source is None for word in rows[0].word_timings)
    assert rows[0].start_ms == 1334
    SentenceMetadata.model_validate(rows[0].metadata())


def test_first_missing_offset_requires_other_fine_grained_evidence():
    source = track([event([{"utf8": "We"}, {"utf8": " agree.", "tOffsetMs": 0}])])
    row = format_track(source)[0]
    assert [word.source_token_index for word in row.word_timings] == [1]
    assert row.word_timings[0].start_ms == 1234
    # The first word is not assigned another invented tOffsetMs=0.


def test_repeated_words_and_fillers_keep_global_normalized_indices():
    source = track([event([
        {"utf8": "Um,", "tOffsetMs": 0}, {"utf8": " yes.", "tOffsetMs": 250},
        {"utf8": " yes.", "tOffsetMs": 650}, {"utf8": " we", "tOffsetMs": 900},
        {"utf8": " uh", "tOffsetMs": 1100}, {"utf8": " agree.", "tOffsetMs": 1400},
    ])])
    rows = format_track(source)
    assert [row.text for row in rows] == ["Yes.", "Yes.", "We agree."]
    assert [(row.source_token_start, row.source_token_end) for row in rows] == [(0, 1), (1, 2), (2, 4)]
    words = [word for row in rows for word in row.word_timings]
    assert [word.source_token_index for word in words] == [0, 1, 2, 3]
    assert [word.source_seg_index for word in words] == [1, 2, 3, 5]
    assert [word.start_ms for word in words] == [1484, 1884, 2134, 2634]
    # An omitted filler still bounds the preceding word estimate.
    assert words[2].end_ms == 2334
    assert len({row.id for row in rows}) == 3


def test_partial_multiword_segments_split_contractions_and_abbreviations_abstain():
    source = track([event([
        {"utf8": "We can", "tOffsetMs": 0}, {"utf8": "'t", "tOffsetMs": 300},
        {"utf8": " visit", "tOffsetMs": 500}, {"utf8": " U.S.", "tOffsetMs": 700},
        {"utf8": " companies.", "tOffsetMs": 1000},
    ])])
    rows = format_track(source)
    assert len(rows) == 1 and rows[0].text == "We can't visit U.S. companies."
    assert [word.source_token_index for word in rows[0].word_timings] == [2, 4]
    assert rows[0].word_timings[0].end_ms is None


def test_filler_inside_one_token_cannot_lend_its_offset_to_the_remaining_word():
    source = track([event([
        {"utf8": "um,we", "tOffsetMs": 0}, {"utf8": " agree.", "tOffsetMs": 500},
    ])])
    row = format_track(source)[0]
    assert row.text == "We agree."
    assert [word.source_token_index for word in row.word_timings] == [1]


@pytest.mark.parametrize("second_start,append", [(1234, None), (1000, None), (1600, 1)])
def test_repeated_same_time_reversed_and_rolling_events_keep_words_but_withhold_offsets(second_start, append):
    source = track([
        event([{"utf8": "Yes.", "tOffsetMs": 0}], wWinId=1),
        event([{"utf8": "Yes.", "tOffsetMs": 0}], start=second_start, aAppend=append, wWinId=1),
    ])
    rows = format_track(source)
    assert [row.text for row in rows] == ["Yes.", "Yes."]
    assert all(row.word_timings is None for row in rows)
    assert rows[0].source_token_end == rows[1].source_token_start == 1


def test_whitespace_only_append_event_does_not_disable_normal_word_offsets():
    source = track([
        event([{"utf8": "\n"}], start=0, aAppend=1),
        event([{"utf8": "We"}, {"utf8": " agree.", "tOffsetMs": 500}]),
    ])
    assert len(format_track(source)[0].word_timings) == 2


def test_overlapping_offset_sequences_are_not_sorted_or_accepted():
    source = track([
        event([{"utf8": "We", "tOffsetMs": 0}, {"utf8": " agree.", "tOffsetMs": 700}], start=1000),
        event([{"utf8": "They", "tOffsetMs": 0}, {"utf8": " agree.", "tOffsetMs": 800}], start=1600),
    ])
    rows = format_track(source)
    assert [row.text for row in rows] == ["We agree.", "They agree."]
    assert all(row.word_timings is None for row in rows)


def test_offset_gaps_do_not_add_sentence_boundaries_or_silence_claims():
    source = track([event([
        {"utf8": "We", "tOffsetMs": 0}, {"utf8": " wait", "tOffsetMs": 10_000},
        {"utf8": " patiently.", "tOffsetMs": 30_000},
    ], duration=40_000)])
    rows = format_track(source)
    assert len(rows) == 1 and rows[0].source_token_end == 3
    assert rows[0].word_timings[0].end_source == "next_word_estimate"
    assert rows[0].word_timings[0].end_ms - rows[0].word_timings[0].start_ms == 10_000
    assert "silence" not in rows[0].metadata()


def test_long_display_duration_does_not_swallow_the_following_sentence():
    source = track([
        event([{"utf8": "We can do this."}], start=1000, duration=10_000),
        event([{"utf8": "They"}, {"utf8": " agree.", "tOffsetMs": 400}], start=2000, duration=1500),
    ])
    rows = format_track(source)
    assert [(row.text, row.start_ms, row.end_ms) for row in rows] == [
        ("We can do this.", 1000, 2000), ("They agree.", 2000, 3500),
    ]
    assert rows[0].word_timings is None
    assert rows[1].timing_source == "caption_word_offsets"


def test_word_start_survives_expired_display_end_without_inventing_a_next_word():
    source = track([
        event([{"utf8": "Yes.", "tOffsetMs": 0}], start=1000, duration=10_000),
        event([{"utf8": "They agree."}], start=2000, duration=1500),
    ])
    rows = format_track(source)
    word = rows[0].word_timings[0]
    assert rows[0].end_ms == 2000
    assert word.start_ms == 1000 and word.end_ms is None and word.end_source is None


def test_word_offsets_crossing_the_next_caption_are_not_used_for_navigation():
    source = track([
        event([{"utf8": "We", "tOffsetMs": 0}, {"utf8": " agree.", "tOffsetMs": 5000}], start=1000, duration=10_000),
        event([{"utf8": "They agree."}], start=2000, duration=1500),
    ])
    rows = format_track(source)
    assert rows[0].word_timings is None and rows[0].end_ms == 2000


def test_mismatched_optional_track_preserves_text_without_lending_timing(monkeypatch):
    monkeypatch.setattr("app.services.transcript_formatter.get_punctuation_engine", lambda language: None)
    source = track([event([{"utf8": "We"}, {"utf8": " agree.", "tOffsetMs": 300}])])
    rows = format_transcript("0:01\tWe disagree.", "en", caption_track=source, syntax_engine=None)
    assert rows[0].text == "We disagree."
    assert rows[0].segmentation_version.startswith("sentence-v2")
    assert rows[0].word_timings is None
    assert caption_track_matches_text(source, "We agree.")
    assert not caption_track_matches_text(source, "We agree. We agree.")


def test_caption_matching_accepts_only_ordered_normalized_lexical_content():
    source = track([event([{"utf8": "um, we can't agree. Yes. Yes."}])])
    assert caption_track_matches_text(source, "0:05\tWe CAN’T agree!\n0:09\tYes. Yes.")
    assert not caption_track_matches_text(source, "We can't agree. Yes.")
    assert not caption_track_matches_text(source, "Yes. We can't agree. Yes.")


def test_source_timing_changes_identity_but_preview_is_stable():
    source = track([event([{"utf8": "Yes.", "tOffsetMs": 0}, {"utf8": " Yes.", "tOffsetMs": 700}])])
    previews = []
    rows = format_track(source, on_progress=previews.append)
    modified = source.model_copy(deep=True)
    modified.events[0].segs[1].tOffsetMs = 800
    assert rows[0].id != format_track(modified)[0].id
    assert all([asdict(row) for row in batch] == [asdict(row) for row in rows[:len(batch)]] for batch in previews)


def test_word_timing_schema_rejects_unlabelled_or_nonmonotonic_estimates():
    raw = {"source_token_index": 0, "text": "We", "start_ms": 1200, "source_event_index": 0, "source_seg_index": 0}
    with pytest.raises(ValidationError):
        CaptionWordTiming.model_validate({**raw, "end_ms": 1400})
    with pytest.raises(ValidationError):
        SentenceMetadata.model_validate({
            "source_token_start": 0, "source_token_end": 2, "timing_source": "caption_word_offsets",
            "word_timings": [raw, {**raw, "source_token_index": 1}],
        })


def test_rich_provider_fallback_preserves_duration_and_never_claims_word_offsets(monkeypatch):
    class Fetched(list):
        language_code = "en"
        is_generated = False

    fetched = Fetched([SimpleNamespace(text="We agree.", start=1.234, duration=2.345)])
    monkeypatch.setattr(youtube_transcript, "YouTubeTranscriptApi", lambda: SimpleNamespace(fetch=lambda *args, **kwargs: fetched))
    source = youtube_transcript.fetch_youtube_caption_track("test-video")
    assert source.version == "youtube-snippets-v1" and source.kind == "manual"
    assert source.events[0].tStartMs == 1234 and source.events[0].dDurationMs == 2345
    assert source.events[0].segs[0].tOffsetMs is None
    assert youtube_transcript.fetch_youtube_transcript("test-video") == "0:01.234\tWe agree."
    row = format_track(source)[0]
    assert (row.start_ms, row.end_ms) == (1234, 3579)
    assert row.word_timings is None


@pytest.mark.parametrize("start,duration", [(float("nan"), 1), (float("inf"), 1), (-1, 1), (1, -1)])
def test_provider_bad_timing_fails_safely(monkeypatch, start, duration):
    fetched = [SimpleNamespace(text="private words", start=start, duration=duration)]
    monkeypatch.setattr(youtube_transcript, "YouTubeTranscriptApi", lambda: SimpleNamespace(fetch=lambda *args, **kwargs: fetched))
    with pytest.raises(youtube_transcript.TranscriptUnavailableError, match="invalid caption timing"):
        youtube_transcript.fetch_youtube_caption_track("test-video")


def test_decimal_timestamp_round_trip_keeps_subsecond_source_anchor():
    rows = parse_transcript("1:02:03.456\tWe agree.\n1:02:04.001\tYes.", preserve_rows=True)
    assert [row.time for row in rows] == ["1:02:03.456", "1:02:04.001"]
    assert timestamp_seconds(rows[0].time) == 3723.456
    assert timestamp_seconds("--:--") is None
    rows = format_transcript("0:01.234\tWe agree.", "en", syntax_engine=None)
    assert rows[0].start_ms == 1234


def test_track_bounded_sizes_and_strict_times():
    with pytest.raises(ValidationError):
        track([event([{"utf8": "We."}], start=True)])
    with pytest.raises(ValidationError):
        track([event([{"utf8": "x" * 240_001}])])
