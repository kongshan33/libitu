import math
import pytest
from app.schemas.reference import Measurements, Frame, Interval, Alignment
from app.schemas.signal_prosody import WordBoundary
from app.services.acoustics.signal_prosody import analyze_signal, subtitle_boundaries, learner_boundaries
from app.services.acoustics.word_check import check_words


def evidence():
    return Measurements(duration_sec=2, rms_dbfs=-22, clipping_fraction=0, f0_valid_fraction=1,
        frames=[Frame(time_sec=i*.01, f0_hz=150*2**(math.sin(i*.08)/6), energy_dbfs=-24+5*math.sin(i*.08)) for i in range(200)],
        speech=[Interval(start_sec=.1,end_sec=1.9)],pauses=[],quality_issues=[])


def boundaries():
    return [WordBoundary(text=str(i),start_sec=.1+i*.4,end_sec=.5+i*.4,source_index=i) for i in range(4)]


def test_coarse_curve_independent_of_boundary_source_and_duration():
    m=evidence();a=analyze_signal(m,boundaries(),'asr_word');b=analyze_signal(m,[], 'subtitle_word')
    assert a.prominence==b.prominence and a.pitch_st==b.pitch_st
    assert not a.duration_evaluated and 'duration_not_evaluated' in a.reasons
    jitter=[w.model_copy(update={'start_sec':w.start_sec+.05,'end_sec':w.end_sec+.05}) for w in boundaries()]
    c=analyze_signal(m,jitter,'subtitle_word')
    assert a.prominence==c.prominence
    for original, shifted in zip(a.words,c.words):
        assert original.sensitivity_range[0] <= shifted.value <= original.sensitivity_range[1]
    assert any(w.uncertain for w in a.words)
    assert a.words==analyze_signal(m,boundaries(),'subtitle_word').words


def test_segment_origin_does_not_shift_comparison():
    m=evidence();a=analyze_signal(m,boundaries(),'subtitle_word')
    for frame in m.frames: frame.time_sec+=11.03
    for speech in m.speech: speech.start_sec+=11.03;speech.end_sec+=11.03
    b=analyze_signal(m,boundaries(),'subtitle_word',origin=11.03)
    assert b.prominence==pytest.approx(a.prominence,nan_ok=True)
    assert [w.value for w in b.words]==pytest.approx([w.value for w in a.words])


def test_pitch_gaps_and_bad_quality_are_not_fabricated():
    m=evidence()
    for frame in m.frames[50:100]:frame.f0_hz=None
    a=analyze_signal(m,boundaries(),'asr_word')
    assert all(v is None for v in a.pitch_st[10:20])
    m.quality_issues=['clipping'];a=analyze_signal(m,boundaries(),'asr_word')
    assert not a.words and not a.prominence and a.reasons==['clipping']


def test_bad_boundaries_keep_signal_but_withhold_words():
    a=analyze_signal(evidence(),[WordBoundary(text='bad',start_sec=.1,end_sec=3)],'asr_word')
    assert a.prominence and not a.words and 'boundary_timing_unavailable' in a.reasons
    s={'text':'hello there','start_ms':1000,'word_timings':[{'text':'hello','start_ms':1000,'end_ms':1200}]}
    assert subtitle_boundaries(s)==[]
    s['word_timings'].append({'text':'there','start_ms':1200,'end_ms':1500})
    assert [w.source_index for w in subtitle_boundaries(s)]==[0,1]
    assert subtitle_boundaries(s)[1].start_sec==.2


def test_timestamps_never_change_matching_and_unmatched_words_have_no_pair():
    text='one two three four five six seven';recognized={'text':'one two three four five six extra','reliable':True}
    before=check_words(text,recognized)
    recognized['words']=[{'text':w,'start_sec':i*.2,'end_sec':(i+1)*.2} for i,w in enumerate(recognized['text'].split())]
    after=check_words(text,recognized)
    assert after.tier==before.tier=='full_85_plus' and after.operations==before.operations
    mapped=learner_boundaries(after)
    assert len(mapped)==7 and mapped[-1].source_index is None
    recognized['words'][1]['text']='wrong'
    assert not check_words(text,recognized).word_timings and check_words(text,recognized).tier==before.tier


def test_precise_duration_only_after_mfa():
    m=evidence();phones=[Interval(start_sec=.2+i*.4,end_sec=.3+i*.45,label='AH1') for i in range(3)]
    fine=analyze_signal(m,boundaries(),'mfa',alignment=Alignment(status='aligned',phones=phones))
    assert fine.duration_evaluated and fine.prominence!=analyze_signal(m,boundaries(),'asr_word').prominence


def test_preview_survives_mfa_failure_but_never_opens_below_gate():
    from app.services.practice_analysis_service import layer_availability
    row={'state':'needs_review','coarse_checkpoint':analyze_signal(evidence(),boundaries(),'asr_word').model_dump()}
    result={'learner':{'alignment_status':'unavailable'}}
    check=check_words('one two three four five',{'text':'one two three four five','reliable':True})
    status=layer_availability(row,result,check)
    assert status['rhythm'].reason==status['melody'].reason=='preliminary' and status['sound'].state=='unavailable'
    check=check_words('one two three four five',{'text':'one two three xx yy','reliable':True})
    assert layer_availability(row,result,check)['rhythm'].state=='locked'


def test_reference_mfa_failure_does_not_hide_saved_paired_preview():
    from app.services.practice_analysis_service import layer_availability
    row={'state':'completed','reference_id':'reference','coarse_checkpoint':analyze_signal(evidence(),boundaries(),'asr_word').model_dump()}
    result={'learner':{'alignment_status':'aligned'},'comparison':'unavailable','reason':'reference_content_or_alignment_unavailable'}
    check=check_words('one two three four five',{'text':'one two three four five','reliable':True})
    status=layer_availability(row,result,check)
    assert status['rhythm'].reason==status['melody'].reason=='preliminary'


def test_learner_only_fine_results_replace_coarse_without_comparison_scores():
    from app.services.practice_analysis_service import layer_availability
    row={'state':'completed','reference_id':None,'coarse_checkpoint':analyze_signal(evidence(),boundaries(),'asr_word').model_dump()}
    result={'learner':{'alignment_status':'aligned','words':[
        {'source_index':i,'phones':[{'label':'AH1'}],'pitch_curve_st':[0,1,None]} for i in range(5)]},
        'comparison':'unavailable','reason':'reference_unavailable','assessment':None}
    check=check_words('one two three four five',{'text':'one two three four five','reliable':True})
    status=layer_availability(row,result,check)
    assert all(layer.state=='partial' and layer.reason=='learner_only' for layer in status.values())
    row['state']='processing'
    assert layer_availability(row,None,check)['rhythm'].reason=='preliminary'
