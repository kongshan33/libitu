"""Create an offline report from a live-teaching artifact directory.

This script never calls a model or writes its input logs. Run after the probe has
exported workspace.json, diagnostics.json and cleanup.json:
    .venv/bin/python -m scripts.report_live_teaching /absolute/artifact/directory
Only README.md and summary.json in that directory are generated.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any


def load_json(path: Path, default: Any = None) -> Any:
    return json.loads(path.read_text()) if path.exists() else default


def load_browser(directory: Path) -> tuple[list[dict], list[str]]:
    rows, warnings = [], []
    for path in sorted(directory.glob("browser*.jsonl")):
        for number, line in enumerate(path.read_text().splitlines(), 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append({**value, "_source": f"{path.name}:{number}"})
            except json.JSONDecodeError:
                warnings.append(f"{path.name}:{number} 不是完整 JSON，未纳入报告。")
    return rows, warnings


def stamp(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.timestamp()
    except ValueError:
        return None


def milliseconds(later: Any, earlier: Any) -> float | None:
    end, start = stamp(later), stamp(earlier)
    return round((end - start) * 1000, 2) if end is not None and start is not None else None


def payload(event: dict) -> dict:
    return event.get("payload") or {}


def json_block(value: Any) -> str:
    content = json.dumps(value, ensure_ascii=False, indent=2)
    fence = "`" * max(3, max(map(len, re.findall(r"`+", content)), default=0) + 1)
    return f"{fence}json\n{content}\n{fence}"


def raw_block(value: Any) -> str:
    if value is None:
        return "未记录原始模型回复。"
    if not isinstance(value, str):
        return json_block(value)
    # Keep the provider's content as returned, including invalid JSON.
    longest = max(map(len, re.findall(r"`+", value)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}json\n{value}\n{fence}"


def first(events: list[dict], kind: str, **match: Any) -> dict | None:
    return next((event for event in events if event.get("kind") == kind
                 and all(payload(event).get(key) == value for key, value in match.items())), None)


def time_of(event: dict | None) -> str | None:
    return event.get("created_at") if event else None


def summarize(directory: Path) -> tuple[dict, list[dict], list[dict]]:
    config = load_json(directory / "config.json", {})
    workspace = load_json(directory / "workspace.json", {})
    source = load_json(directory / "diagnostics.json", [])
    events = source.get("events", []) if isinstance(source, dict) else source
    if not isinstance(events, list):
        raise ValueError("diagnostics.json must contain an event array or {events: [...]}.")
    events = sorted(events, key=lambda row: (row.get("created_at", ""), row.get("id", "")))
    browser, warnings = load_browser(directory)
    browser.sort(key=lambda row: (row.get("at", ""), row.get("performance_ms", 0)))
    browser_errors = [row for row in browser if row.get("kind") in {"server.error", "socket.error"}
                      or row.get("status") == "failed"]
    if browser_errors:
        warnings.append("浏览器记录了错误；必须结合错误和未完成命令判断本次覆盖范围。")
    for name in ("config.json", "workspace.json", "diagnostics.json", "cleanup.json"):
        if not (directory / name).exists():
            warnings.append(f"缺少 {name}，相关结论只能标为未知。")
    messages = sorted(workspace.get("messages", []), key=lambda row: row.get("ordinal", 0))
    users = [row for row in messages if row.get("role") == "user" and row.get("text", "").strip()]
    user_numbers = {row["id"]: index + 1 for index, row in enumerate(users)}
    responses = {row.get("response_id"): row for row in messages
                 if row.get("role") == "assistant" and row.get("response_id")}
    target_texts = {str(row.get("id")): row.get("text", "")
                    for row in (workspace.get("session") or {}).get("items", [])}
    turns = []
    for number, user in enumerate(users, 1):
        revision = user.get("revision", 1)
        analyses = []
        for event in events:
            data = payload(event)
            if event.get("kind") != "analysis.completed" or data.get("message_id") != user["id"]:
                continue
            run_id = data.get("run_id")
            trace = data.get("trace") or {}
            analyses.append({"run_id": run_id, "revision": data.get("revision"),
                "current_revision": data.get("revision") == revision,
                "started_at": time_of(first(events, "analysis.started", run_id=run_id)),
                "completed_at": event.get("created_at"), "status": data.get("status"),
                "trace": trace, "policy": data.get("policy"),
                "reconciled": first(events, "analysis.reconciled", run_id=run_id)})
        next_ordinal = users[number].get("ordinal", float("inf")) if number < len(users) else float("inf")
        replies = [row for row in messages if row.get("role") == "assistant"
                   and user.get("ordinal", 0) < row.get("ordinal", 0) < next_ordinal]
        reply_summaries = []
        for reply_index, reply in enumerate(replies):
            response_id = reply.get("response_id")
            audio = first(events, "response.first_audio", response_id=response_id)
            browser_audio = next((row for row in browser if row.get("kind") == "server.audio.delta"
                                  and row.get("response_id") == response_id), None)
            web_audio = next((row for row in browser if row.get("kind") == "audio.clock_started"
                              and row.get("response_id") == response_id), None)
            current = next((run for run in reversed(analyses) if run["current_revision"]), None)
            start_delta = milliseconds(time_of(audio), current["started_at"]) if current else None
            complete_delta = milliseconds(time_of(audio), current["completed_at"]) if current else None
            reply_summaries.append({"response_id": response_id, "message_id": reply["id"],
                "position_after_user": reply_index + 1,
                "text": reply.get("text", ""), "status": reply.get("status"),
                "first_audio_at": time_of(audio), "browser_first_audio_at": (browser_audio or {}).get("at"),
                "web_audio_clock_started_at": (web_audio or {}).get("at"),
                "first_audio_minus_analysis_started_ms": start_delta,
                "first_audio_minus_analysis_completed_ms": complete_delta,
                "audio_before_analysis_start": start_delta < 0 if start_delta is not None else None,
                "audio_before_analysis_complete": complete_delta < 0 if complete_delta is not None else None})
        turns.append({"turn": number, "message_id": user["id"], "revision": revision,
            "input_source": user.get("input_source"), "status": user.get("status"), "text": user.get("text"),
            "analyses": analyses, "replies": reply_summaries,
            "evidence": [row for row in workspace.get("evidence", []) if row.get("message_id") == user["id"]],
            "key_events": [event for event in events if payload(event).get("message_id") == user["id"]
                           and event.get("kind", "").startswith("analysis.")]})
    attempts = []
    for event in events:
        if event.get("kind") != "policy.bound":
            continue
        attempt = payload(event).get("attempt") or {}
        policy = attempt.get("policy") or {}
        response = responses.get(attempt.get("response_id"))
        responding_user = next((row for row in reversed(users) if response
                                and row.get("ordinal", 0) < response.get("ordinal", 0)), None)
        source_turn = user_numbers.get(policy.get("source_message_id"))
        reply_turn = user_numbers.get(responding_user["id"]) if responding_user else None
        assessed = first(events, "policy.assessed", attempt_id=attempt.get("id"))
        assessment = payload(assessed).get("assessment") or {}
        quote = assessment.get("quote") or assessment.get("exact_quote")
        text = (response or {}).get("text", "")
        target_text = target_texts.get(policy.get("target_item_id"), "")
        attempt_events = [row for row in events if (payload(row).get("attempt") or {}).get("id") == attempt.get("id")
                          or payload(row).get("attempt_id") == attempt.get("id")]
        sent = next((row for row in attempt_events if row.get("kind") == "policy.sent"), None)
        attempts.append({"attempt_id": attempt.get("id"), "policy_id": policy.get("id"),
            "source_turn": source_turn, "reply_turn": reply_turn,
            "cross_turn": reply_turn > source_turn if reply_turn is not None and source_turn is not None else None,
            "turn_distance": reply_turn - source_turn if reply_turn is not None and source_turn is not None else None,
            "source_revision_matches": next((row.get("revision") == policy.get("source_revision") for row in users
                                             if row["id"] == policy.get("source_message_id")), None),
            "send_started_at": attempt.get("sent_at"), "sent_at": time_of(sent),
            "bound_at": attempt.get("bound_at"), "bound_logged_at": event.get("created_at"),
            "validity_at_bind": attempt.get("validity_at_bind"), "policy": policy,
            "response_id": attempt.get("response_id"), "response_text": text,
            "target_text": target_text,
            "implicit_reply_names_target_literal": bool(target_text and target_text.casefold() in text.casefold())
                if policy.get("action") == "implicit_elicitation" else None,
            "response_status": (response or {}).get("status"), "assessment": assessment,
            "assessment_source": (assessment.get("analysis_trace") or {}).get("assessment_source"),
            "implicit_constraint_check": (assessment.get("analysis_trace") or {}).get("constraint_check"),
            "assessment_quote_matches_response": bool(quote and quote in text), "events": attempt_events,
            "presentation": [row for row in events if payload(row).get("response_id") == attempt.get("response_id")
                             and row.get("kind") in {"response.shown", "response.playback", "response.expression_exposed"}]})
    hints = [row for row in events if row.get("kind", "").startswith("hint.")]
    browser_hint_acks = {(row.get("event", {}).get("hint_id"), row.get("event", {}).get("version"),
                          row.get("event", {}).get("level")) for row in browser
                         if row.get("kind") == "client.hint.shown"}
    hint_presentations = [{"at": row.get("created_at"), **payload(row),
        "matching_browser_ack": (payload(row).get("hint_id"), payload(row).get("version"),
                                 payload(row).get("level")) in browser_hint_acks}
        for row in hints if row.get("kind") == "hint.shown"]
    overlaps = []
    playback_overlaps = []
    playback_starts = {row.get("id"): row for row in browser if row.get("kind") == "audio.clock_started"}
    playback_ends = {row.get("id"): row for row in browser if row.get("kind") == "audio.ended"}
    playback_schedules = {row.get("id"): row for row in browser if row.get("kind") == "audio.scheduled"}
    stale_clock_events = [{"audio_node_id": key, "response_id": began.get("response_id"),
                          "clock_started_at": began.get("at"), "ended_at": playback_ends[key].get("at"),
                          "scheduled_context_start": playback_schedules.get(key, {}).get("start_at"),
                          "ended_context_time": playback_ends[key].get("context_time")}
                         for key, began in playback_starts.items() if key in playback_ends
                         and stamp(began.get("at")) is not None and stamp(playback_ends[key].get("at")) is not None
                         and stamp(began["at"]) >= stamp(playback_ends[key]["at"])]
    for event in events:
        if event.get("kind") != "analysis.completed":
            continue
        trace = payload(event).get("trace") or {}
        start, end = stamp(trace.get("started_at")), stamp(trace.get("completed_at"))
        if start is None or end is None:
            continue
        matching = [row for row in browser if row.get("kind") == "server.audio.delta"
                    and (when := stamp(row.get("at"))) is not None and start <= when <= end]
        if matching:
            overlaps.append({"run_id": payload(event).get("run_id"), "source_message_id": payload(event).get("message_id"),
                "provider_started_at": trace.get("started_at"), "analysis_completed_at": trace.get("completed_at"),
                "received_audio_frames": len(matching), "response_ids": sorted({row["response_id"] for row in matching
                                                                                 if row.get("response_id")}),
                "first_frame_at": matching[0].get("at"), "last_frame_at": matching[-1].get("at")})
        playing = []
        for key, began in playback_starts.items():
            ended = playback_ends.get(key)
            began_at, ended_at = stamp(began.get("at")), stamp((ended or {}).get("at"))
            if began_at is not None and ended_at is not None and began_at < ended_at and began_at < end and ended_at > start:
                playing.append({"audio_node_id": key, "response_id": began.get("response_id"),
                    "started_at": began.get("at"), "ended_at": ended.get("at"),
                    "overlap_ms": round((min(end, ended_at) - max(start, began_at)) * 1000, 2)})
        if playing:
            playback_overlaps.append({"run_id": payload(event).get("run_id"),
                "source_message_id": payload(event).get("message_id"),
                "provider_started_at": trace.get("started_at"), "analysis_completed_at": trace.get("completed_at"),
                "playing_audio_nodes": len(playing), "nodes": playing})
    gaps = [row for row in events if row.get("kind") in {"diagnostics.gap", "diagnostics.closed"}]
    if any(payload(row).get("missing_events", 0) for row in gaps):
        warnings.append("诊断记录报告丢失事件，不能把缺失事件解释为动作未发生。")
    playback_by_response: dict[str, dict] = {}
    for row in browser:
        if row.get("kind") not in {"server.audio.delta", "audio.scheduled", "audio.clock_started", "audio.ended"}:
            continue
        key = row.get("response_id") or row.get("item_id") or "unknown"
        record = playback_by_response.setdefault(key, {"response_id": row.get("response_id"),
            "item_id": row.get("item_id"), "event_counts": {}, "first_at": row.get("at"), "last_at": row.get("at")})
        record["event_counts"][row["kind"]] = record["event_counts"].get(row["kind"], 0) + 1
        record["last_at"] = row.get("at")
    voice_first_replies = [turn["replies"][0] for turn in turns if turn["input_source"] == "voice" and turn["replies"]]
    analysis_leads = [-reply["first_audio_minus_analysis_completed_ms"] for reply in voice_first_replies
                      if reply["first_audio_minus_analysis_completed_ms"] is not None]
    rejected_evidence = [{"turn": turn["turn"], "run_id": run["run_id"], **entry,
                         "quote_utf16_length": len(entry.get("candidate", {}).get("quote", "").encode("utf-16-le")) // 2}
                        for turn in turns for run in turn["analyses"] for entry in run["trace"].get("rejected", [])
                        if entry.get("kind") == "evidence"]
    anchored_evidence = []
    for turn in turns:
        for run in turn["analyses"]:
            for entry in run["trace"].get("accepted", []):
                anchor = entry.get("quote_anchor")
                if entry.get("kind") != "evidence" or not anchor:
                    continue
                quote = entry.get("candidate", {}).get("quote", "")
                try:
                    actual = turn["text"].encode("utf-16-le")[anchor["start"] * 2:anchor["end"] * 2].decode("utf-16-le")
                except (UnicodeError, KeyError, TypeError):
                    actual = None
                anchored_evidence.append({"turn": turn["turn"], "run_id": run["run_id"], **entry,
                                          "exact_utf16_slice_matches": actual == quote})
    result = {"generated_at": datetime.now(timezone.utc).isoformat(), "session_id": config.get("sessionId"),
        "models": config.get("models", {}), "turn_count": len(users), "diagnostic_event_count": len(events),
        "user_rows_by_status": dict(Counter(row.get("status", "unknown") for row in users)),
        "browser_event_count": sum(row.get("_source", "").startswith("browser-events.jsonl:") for row in browser),
        "browser_result_count": sum(row.get("_source", "").startswith("browser-results.jsonl:") for row in browser),
        "event_counts": dict(sorted(Counter(row.get("kind") for row in events).items())),
        "turns": turns, "attempts": attempts, "hints": hints, "hint_presentations": hint_presentations,
        "observations": {
            "voice_first_reply_count": len(voice_first_replies),
            "voice_first_replies_with_analysis_timing": sum(reply["audio_before_analysis_start"] is not None for reply in voice_first_replies),
            "voice_first_audio_before_analysis_start": sum(reply["audio_before_analysis_start"] is True for reply in voice_first_replies),
            "voice_first_audio_lead_over_analysis_complete_ms": {
                "min": min(analysis_leads) if analysis_leads else None, "max": max(analysis_leads) if analysis_leads else None},
            "analysis_windows_with_running_web_audio": len(playback_overlaps),
            "replies_with_audio_before_analysis_start": sum(reply["audio_before_analysis_start"] is True
                for turn in turns for reply in turn["replies"]),
            "replies_with_audio_before_analysis_complete": sum(reply["audio_before_analysis_complete"] is True
                for turn in turns for reply in turn["replies"]),
            "cross_turn_bound_attempts": sum(row["cross_turn"] is True for row in attempts),
            "cross_turn_bound_while_eligible": sum(row["cross_turn"] is True
                and row["validity_at_bind"] == "eligible" for row in attempts),
            "cross_turn_reflected_with_exact_quote": sum(row["cross_turn"] is True
                and row["assessment"].get("outcome") == "reflected" and row["assessment_quote_matches_response"]
                for row in attempts),
            "implicit_constraint_passed": sum((row["implicit_constraint_check"] or {}).get("status") == "passed" for row in attempts),
            "implicit_constraint_failed": sum((row["implicit_constraint_check"] or {}).get("status") == "failed" for row in attempts),
            "accepted_quote_anchor_sources": dict(Counter(row["quote_anchor"]["source"] for row in anchored_evidence)),
            "accepted_anchors_with_exact_utf16_slice": sum(row["exact_utf16_slice_matches"] for row in anchored_evidence),
            "hint_presentations_with_matching_browser_ack": sum(row["matching_browser_ack"] for row in hint_presentations)},
        "browser_presentation_events": [row for row in browser if row.get("kind") in {
            "client.hint", "client.hint.shown", "client.message.shown"}],
        "browser_audio_by_response": list(playback_by_response.values()),
        "browser_microphone_events": [row for row in browser if row.get("kind") in {
            "microphone.speak_started", "microphone.speak_ended"}],
        "browser_clock_after_node_ended": stale_clock_events,
        "audio_during_analysis_windows": overlaps, "playback_during_analysis_windows": playback_overlaps,
        "rejected_model_evidence": rejected_evidence,
        "anchored_model_evidence": anchored_evidence,
        "diagnostic_integrity": gaps,
        "cleanup": load_json(directory / "cleanup.json", {}), "warnings": warnings,
        "browser_errors": browser_errors,
        "execution_notes": load_json(directory / "execution-notes.json", {}),
        "limits": ["真实模型单次运行不代表所有输入、网络条件或物理麦克风/扬声器延迟。",
            "首音使用服务端转发时间；浏览器收包与 WebAudio 调度另列，不等同于声学输出。",
            "浏览器与服务端 UTC 均为本机墙上时钟；跨进程差值不是独立时钟校准结果。",
            "audio.ended 是 onended；主动 stop 也会触发，不能据此声称每帧完整播放。",
            "只有 clock_started 早于同一节点 ended 的区间才参与播放交叠统计；节点结束后才报告的 clock_started 不计。",
            "回复关联按保存消息 ordinal；自动静默追问也可能出现在同一用户轮下。",
            "跨轮绑定与模型判定 reflected 是执行/内容证据，不是因果归因或教学效果证明。",
            "hint.shown 是实际产品可见性 ACK，不能证明用户注视、理解或学习。",
            "analysis 时间窗口包括本地验证/回写前处理；重叠收包不等于模型同一时刻生成。"]}
    return result, events, browser


def render_report(summary: dict, directory: Path) -> str:
    observed = summary["observations"]
    lead = observed["voice_first_audio_lead_over_analysis_complete_ms"]
    lead_text = (f"{lead['min'] / 1000:.2f}–{lead['max'] / 1000:.2f} 秒" if lead["min"] is not None else "未知")
    if observed["voice_first_reply_count"]:
        measured = observed["voice_first_replies_with_analysis_timing"]
        missing = observed["voice_first_reply_count"] - measured
        timing = (f"1. 语音时序：{observed['voice_first_audio_before_analysis_start']}/{measured} 个有分析时间记录的语音首次回复，"
                  f"首音先于本轮文本模型分析启动，早于分析完成 {lead_text}。"
                  f"另有 {missing} 个语音首次回复缺少对应分析时间，不能判断其与分析的先后。")
    else:
        timing = ("1. 本次使用文本输入，Gemini 输出真实音频；没有语音输入时序可供判断。"
                  f"记录中有 {observed['replies_with_audio_before_analysis_complete']} 个回复的首音早于本轮分析完成。")
    timing += (f"{observed['analysis_windows_with_running_web_audio']} 个分析窗口与实际运行的 WebAudio 播放相交；"
               f"{len(summary['audio_during_analysis_windows'])} 个窗口内收到新音频包。播放和网络收包分开统计，"
               "这些单次记录不保证所有网络条件下的时延。")
    content_result = (f"3. 内容落实：{observed['cross_turn_reflected_with_exact_quote']} 个跨轮尝试被评为 reflected 且有可核对的精确引用。"
                      "实际回复、确定性约束检查和评估原文见下，不能用传递成功代替内容落实。"
                      if summary["attempts"] else "3. 内容落实：本次没有已绑定的策略尝试，未覆盖内容落实验证。")
    lines = ["# Gemini Live 与文本分析真实端到端记录", "",
        f"会话：`{summary['session_id']}`。模型：`{summary['models'].get('gemini', 'unknown')}` / "
        f"`{summary['models'].get('ark', summary['models'].get('gemini_text', summary['models'].get('deepseek', 'unknown')))}`。记录 {summary['turn_count']} 个非空用户轮、"
        f"{summary['diagnostic_event_count']} 条服务端诊断、{summary['browser_event_count']} 条浏览器记录。", "",
        "## 执行状态", "", json_block({"user_rows_by_status": summary["user_rows_by_status"],
                                      "warnings": summary["warnings"], "errors": summary["browser_errors"],
                                      "execution_notes": summary["execution_notes"]}), "",
        "## 三项独立结果", "",
        timing,
        f"2. 跨轮传递：{observed['cross_turn_bound_while_eligible']} 个策略在后续用户轮回复中绑定，且绑定时仍 eligible。",
        content_result, "",
        "本次可直接复核的观察计数（模型评估与因果结论分开）：", "", json_block(observed), "",
        "原始文件保持不变：[诊断](diagnostics.json)、[最终会话](workspace.json)、[浏览器事件](browser-events.jsonl)、"
        "[浏览器命令结果](browser-results.jsonl)、[配置](config.json)、[清理结果](cleanup.json)、[结构化报告](summary.json)。", "",
        "## 时序结论", "",
        "差值 = 服务端首音时间 − 该轮分析时间，负数表示语音先发出。没有对应分析/回复时记为未知。", "",
        "| 用户轮 | 同轮第几个回复 | 首音 − 分析启动 ms | 首音 − 分析完成 ms |", "|---|---|---:|---:|"]
    for turn in summary["turns"]:
        for reply in turn["replies"]:
            values = [reply.get("first_audio_minus_analysis_started_ms"), reply.get("first_audio_minus_analysis_completed_ms")]
            lines.append(f"| {turn['turn']} | {reply['position_after_user']} | " + " | ".join(str(v) if v is not None else "未知" for v in values) + " |")
    lines += ["", "同一用户轮下第 2 个及之后的回复可能是已有的静默推进，不能当作该用户输入的首次响应延迟。", "",
              "文本输入可能恰好先完成分析：正差值本身不能证明音频回复在等待分析。输入方式、首音和播放交叠需分别核对。", "",
              "分析时间窗口内收到新音频包的观察（包括服务器验证阶段；非物理播放测量）：", "",
              json_block(summary["audio_during_analysis_windows"]), "",
              "分析时间窗口内 WebAudio 已在实际运行时钟中播放的节点（收包和播放独立记录）：", "",
              json_block(summary["playback_during_analysis_windows"]), "", "## 跨轮策略执行", ""]
    if not summary["attempts"]:
        lines += ["本次日志没有找到 `policy.bound`；不能认定策略已关联到回复。", ""]
    for attempt in summary["attempts"]:
        lines += [f"### 来源第 {attempt['source_turn']} 轮 → 回复第 {attempt['reply_turn']} 轮", "",
            f"尝试 `{attempt['attempt_id']}`，跨轮 `{attempt['cross_turn']}`，绑定校验 `{attempt['validity_at_bind']}`。", "",
            "实际 Gemini 回复：", "", raw_block(attempt["response_text"]), "",
            "回复后评估（确定性约束和模型建议分别记录，不能视为因果证明）：", "", json_block(attempt["assessment"]), "",
            f"评估来源：`{attempt['assessment_source']}`。", "",
            f"评估引用是否逐字存在于回复：`{attempt['assessment_quote_matches_response']}`。", "",
            f"隐式引导回复是否直接包含目标表达原文：`{attempt['implicit_reply_names_target_literal']}`"
            "（true 表示与本次隐式策略“不点名目标表达”的要求不符；只检查字面包含）。", "",
            "策略发送、绑定、评估原始记录：", "", json_block(attempt["events"]), "",
            "展示/播放记录：", "", json_block(attempt["presentation"]), ""]
    lines += ["## 每轮分析与原始文本模型回复", ""]
    for turn in summary["turns"]:
        lines += [f"### 第 {turn['turn']} 轮", "", f"用户 `{turn['message_id']}`，revision `{turn['revision']}`，"
            f"输入 `{turn['input_source']}`，状态 `{turn['status']}`：", "", raw_block(turn["text"]), ""]
        if not turn["analyses"]:
            lines += ["没有 `analysis.completed`，不能推断模型完成或成功。", ""]
        for run in turn["analyses"]:
            trace = run["trace"]
            lines += [f"分析 `{run['run_id']}`，revision `{run['revision']}`，status `{run['status']}`，"
                f"耗时 `{trace.get('elapsed_ms', 'unknown')} ms`，策略原因 `{trace.get('policy_reason', 'unknown')}`。", "",
                "文本模型原始内容：", "", raw_block(trace.get("raw_content")), "",
                "解析、证据校验与策略决策：", "", json_block({key: value for key, value in trace.items() if key != "raw_content"}), ""]
        lines += ["该轮关键诊断原文：", "", json_block(turn["key_events"]), "",
                  "最终证据及提示来源：", "", json_block(turn["evidence"]), "",
                  "该轮回复与时序：", "", json_block(turn["replies"]), ""]
    lines += ["## 引用范围与确定性定位", "", "逐字引用由服务端定位或校验；保留模型原范围、最终 UTF-16 范围和独立切片复核。", "",
              json_block(summary["anchored_model_evidence"]), "",
              "## 提示生成与实际展示", "", "以下保留请求、模型帮助分析、生成、展示、丢弃/失败等独立状态；生成不等于展示。", "",
              "服务端展示记录与浏览器 `client.hint.shown` 按 id/version/level 的对应关系：", "",
              json_block(summary["hint_presentations"]), "", json_block(summary["hints"]), "",
              "浏览器产品发出的请求和可见性 ACK：", "", json_block(summary["browser_presentation_events"]), "",
              "WebAudio 每个回复的收包、调度、运行时钟启动、结束计数（逐帧原文保留在 browser-events.jsonl）：", "",
              json_block(summary["browser_audio_by_response"]), "",
              "节点 ended 后才触发的 clock_started 探针（不计入播放交叠；也列出计划 start_at 与 ended 的 AudioContext 时间以供复核）：", "",
              json_block(summary["browser_clock_after_node_ended"]), "",
              "虚拟麦克风输入事件（一次输入可能被 VAD 划分为多个保存的用户轮）：", "",
              json_block(summary["browser_microphone_events"]), "", "## 日志完整性与清理", "",
              json_block({"diagnostic_integrity": summary["diagnostic_integrity"], "cleanup": summary["cleanup"],
                          "warnings": summary["warnings"]}), "", "## 解释边界", ""]
    if summary["rejected_model_evidence"]:
        lines += ["被拒绝的模型证据：", "", json_block(summary["rejected_model_evidence"]), "",
                  "例如 UTF-16 范围不匹配时，模型返回的 appropriate 不能被采纳；最终证据可能只是词面匹配、"
                  "appropriateness=uncertain。提示来源 example/prompted 与语义适切性是独立字段。", ""]
    lines += [f"- {item}" for item in summary["limits"]]
    screenshots = sorted(directory.glob("*.png"))
    if screenshots:
        lines += ["", "## 浏览器截图", ""]
        lines += [f"- [{path.name}]({path.name})" for path in screenshots]
    lines += ["", "## 复现报告", "", "```bash", "cd apps/api",
              f".venv/bin/python -m scripts.report_live_teaching {directory}", "```", ""]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact_directory", type=Path)
    args = parser.parse_args()
    directory = args.artifact_directory.resolve(strict=True)
    summary, _, _ = summarize(directory)
    (directory / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    (directory / "README.md").write_text(render_report(summary, directory))
    print(json.dumps({"report": str(directory / "README.md"), "turns": summary["turn_count"],
                      "attempts": len(summary["attempts"]), "warnings": summary["warnings"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
