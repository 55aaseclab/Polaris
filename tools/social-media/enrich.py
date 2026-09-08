#!/usr/bin/env python3
"""Configuration-driven business-account enrichment for JustOneAPI routes."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import runner


def identifier_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def dynamic_call(client: Any, spec: dict[str, Any], parameter_value: str) -> Any:
    resource = getattr(client, spec["resource"], None)
    if resource is None:
        raise runner.CliError(f"locked SDK does not provide resource {spec['resource']}")
    method = getattr(resource, spec["method"], None)
    if method is None:
        raise runner.CliError(f"locked SDK does not provide method {spec['resource']}.{spec['method']}")
    return method(**{spec["parameter"]: parameter_value})


def response_error(response: Any, token: str) -> dict[str, Any] | None:
    if getattr(response, "success", False):
        return None
    raw = getattr(response, "raw_json", {})
    code = getattr(response, "code", None)
    message = runner.safe_text(getattr(response, "message", ""), token)
    request_id = runner.safe_text(raw.get("requestId") if isinstance(raw, dict) else None, token, 200) or None
    return {
        "classification": runner.classify_business_error(code, message),
        "api_code": code,
        "message": message,
        "request_id": request_id,
        "resume_required": True,
    }


def profile_mapping(data: Any) -> dict[str, Any] | None:
    for item in runner.nested_values(data):
        if not isinstance(item, dict):
            continue
        keys = {str(key).lower() for key in item}
        if "username" in keys and (
            "is_business_account" in keys
            or "is_professional_account" in keys
            or "business_category_name" in keys
            or "category_name" in keys
        ):
            return item
    return None


def detail_username(data: Any) -> str | None:
    owner = runner.first_mapping(data if isinstance(data, dict) else {}, ("owner",))
    username = runner.first_value(owner, ("username",))
    if isinstance(username, str) and username.strip():
        normalized = username.strip().lstrip("@")
        if runner.re.fullmatch(r"[A-Za-z0-9._]+", normalized):
            return normalized
    return None


def build_candidate(
    profile: dict[str, Any],
    *,
    username: str,
    shortcode: str,
    task_state: dict[str, Any],
    route: dict[str, Any],
) -> dict[str, Any] | None:
    evidence = runner.business_evidence(profile, profile)
    if not evidence:
        return None
    enrichment = route["account_enrichment"]
    account_url = route["account_url_template"].format(account_handle=username, post_code=shortcode)
    post_url = route["post_url_template"].format(account_handle=username, post_code=shortcode)
    website = runner.first_value(profile, ("external_url", "externalurl", "website", "website_url"))
    if not isinstance(website, str) or not website.startswith(("https://", "http://")):
        website = None
    display_name = runner.short_text(runner.first_value(profile, ("full_name", "fullName")), 160)
    summary = runner.short_text(runner.first_value(profile, ("biography", "bio", "description")), 280)
    return {
        "company_name": display_name,
        "platform": task_state["platform"],
        "account_handle": username,
        "account_url": account_url,
        "post_url": post_url,
        "market": task_state.get("market"),
        "city": task_state.get("city"),
        "buyer_type_ids": task_state.get("buyer_type_ids", []),
        "public_business_evidence": evidence,
        "public_website_url": website,
        "profile_summary": summary,
        "eligible_for_lead": False,
        "verification_required": [
            "confirm_business_account",
            "confirm_target_market_operation",
            "confirm_official_website",
            "confirm_buyer_type_and_product_fit",
        ],
        "source_trace": {
            "source_type": "social_media",
            "platform": task_state["platform"],
            "task_id": task_state["task_id"],
            "query": task_state["query"],
            "discovery_endpoint": route["endpoint_path"],
            "post_detail_endpoint": enrichment["post_detail"]["endpoint_path"],
            "profile_endpoint": enrichment["profile"]["endpoint_path"],
            "post_url": post_url,
            "enriched_at": runner.utc_now(),
        },
    }


def enrichment_template(task: dict[str, Any], route: dict[str, Any], normalized_query: str) -> dict[str, Any]:
    return {
        "schema_version": "clue-justoneapi-cli.enrichment-task.v1",
        "task_id": task["task_id"],
        "platform": task["platform"],
        "market": task.get("market"),
        "city": task.get("city"),
        "query": task["query"],
        "normalized_query": normalized_query,
        "buyer_type_ids": task.get("buyer_type_ids", []),
        "status": "pending",
        "started_at": None,
        "finished_at": None,
        "discovery_completed": False,
        "post_shortcodes": [],
        "completed_post_shortcodes": [],
        "post_details_attempted": 0,
        "profiles_attempted": 0,
        "candidates": [],
        "candidate_count": 0,
        "attempts": [],
        "last_error": None,
        "route": {
            "discovery_endpoint": route["endpoint_path"],
            "post_detail_endpoint": route["account_enrichment"]["post_detail"]["endpoint_path"],
            "profile_endpoint": route["account_enrichment"]["profile"]["endpoint_path"],
        },
    }


def write_log_header(directory: Path, lock: dict[str, Any], token_file: Path | str, max_posts: int | None) -> None:
    limit = "all discovered posts" if max_posts is None else str(max_posts)
    (directory / "execution-log.md").write_text(
        "\n".join(
            [
                "# JustOneAPI 账号补全：执行日志",
                "",
                "本阶段用帖子详情取得公开账号句柄，再用用户资料判断明确企业属性。未通过企业判断的用户名和资料会立即丢弃。",
                "",
                "## 运行命令",
                "",
                "```sh",
                f"clue-justoneapi-cli enrich --output {directory.parent} --token-file {token_file}",
                "```",
                "",
                "令牌不写入日志；请求日志中的帖子和账号标识仅保存不可逆哈希。",
                "",
                "## 固定依赖",
                "",
                f"- CLI：`{lock['cli']['name']}` `{lock['cli']['version']}`",
                f"- SDK：`{lock['backend']['commit']}`",
                f"- 每任务帖子详情上限：`{limit}`",
                "",
                "## 任务结果",
                "",
            ]
        ),
        encoding="utf-8",
    )


def append_command(path: Path, payload: dict[str, Any]) -> None:
    payload["token_logged"] = False
    runner.append_jsonl(path, payload)


def set_error(state: dict[str, Any], error: dict[str, Any]) -> dict[str, Any]:
    state["status"] = error["classification"]
    state["last_error"] = error
    state["finished_at"] = runner.utc_now()
    return state


def collect_discovery(client: Any, state: dict[str, Any], route: dict[str, Any], commands: Path, token: str) -> dict[str, Any]:
    if state["discovery_completed"]:
        return state
    at = runner.utc_now()
    append_command(
        commands,
        {
            "executed_at": at,
            "task_id": state["task_id"],
            "stage": "discovery",
            "method": "GET",
            "endpoint_path": route["endpoint_path"],
            "parameters": {route["query_parameter"]: state["normalized_query"]},
        },
    )
    try:
        response = runner.call_provider(client, route, state["normalized_query"], "")
    except Exception as exc:
        return set_error(
            state,
            {
                "classification": "failed_transport",
                "api_code": None,
                "message": runner.safe_text(exc, token),
                "request_id": None,
                "resume_required": True,
            },
        )
    error = response_error(response, token)
    if error:
        append_command(commands, {"finished_at": runner.utc_now(), "task_id": state["task_id"], "stage": "discovery", **error})
        return set_error(state, error)
    codes = sorted(
        {
            str(record.get("shortcode")).strip()
            for record in runner.find_post_records(getattr(response, "data", None))
            if isinstance(record.get("shortcode"), str) and str(record.get("shortcode")).strip()
        }
    )
    state["post_shortcodes"] = codes
    state["discovery_completed"] = True
    state["attempts"].append(
        {"at": at, "stage": "discovery", "status": "succeeded", "posts_discovered": len(codes), "api_code": response.code}
    )
    append_command(
        commands,
        {"finished_at": runner.utc_now(), "task_id": state["task_id"], "stage": "discovery", "status": "succeeded", "api_code": response.code, "posts_discovered": len(codes)},
    )
    return state


def enrich_one_post(client: Any, state: dict[str, Any], route: dict[str, Any], shortcode: str, token: str) -> dict[str, Any]:
    """Return safe metadata and an optional business candidate for one post."""
    enrichment = route["account_enrichment"]
    events: list[dict[str, Any]] = []
    detail_at = runner.utc_now()
    events.append(
        {
            "executed_at": detail_at,
            "task_id": state["task_id"],
            "stage": "post_detail",
            "method": "GET",
            "endpoint_path": enrichment["post_detail"]["endpoint_path"],
            "identifier_sha256": identifier_hash(shortcode),
        }
    )
    try:
        detail = dynamic_call(client, enrichment["post_detail"], shortcode)
    except Exception as exc:
        error = {"classification": "failed_transport", "api_code": None, "message": runner.safe_text(exc, token), "request_id": None, "resume_required": True}
        events.append({"finished_at": runner.utc_now(), "task_id": state["task_id"], "stage": "post_detail", **error})
        return {"shortcode": shortcode, "events": events, "error": error}
    error = response_error(detail, token)
    if error:
        events.append({"finished_at": runner.utc_now(), "task_id": state["task_id"], "stage": "post_detail", **error})
        return {"shortcode": shortcode, "events": events, "error": error}
    username = detail_username(getattr(detail, "data", None))
    events.append(
        {
            "finished_at": runner.utc_now(),
            "task_id": state["task_id"],
            "stage": "post_detail",
            "status": "succeeded",
            "api_code": detail.code,
            "has_public_handle": bool(username),
        }
    )
    if not username:
        return {"shortcode": shortcode, "events": events, "candidate": None, "profile_attempted": False}

    profile_at = runner.utc_now()
    events.append(
        {
            "executed_at": profile_at,
            "task_id": state["task_id"],
            "stage": "user_profile",
            "method": "GET",
            "endpoint_path": enrichment["profile"]["endpoint_path"],
            "identifier_sha256": identifier_hash(username),
        }
    )
    try:
        profile_response = dynamic_call(client, enrichment["profile"], username)
    except Exception as exc:
        error = {"classification": "failed_transport", "api_code": None, "message": runner.safe_text(exc, token), "request_id": None, "resume_required": True}
        events.append({"finished_at": runner.utc_now(), "task_id": state["task_id"], "stage": "user_profile", **error})
        return {"shortcode": shortcode, "events": events, "error": error, "profile_attempted": True}
    error = response_error(profile_response, token)
    if error:
        events.append({"finished_at": runner.utc_now(), "task_id": state["task_id"], "stage": "user_profile", **error})
        return {"shortcode": shortcode, "events": events, "error": error, "profile_attempted": True}
    profile = profile_mapping(getattr(profile_response, "data", None))
    candidate = build_candidate(profile, username=username, shortcode=shortcode, task_state=state, route=route) if profile else None
    events.append(
        {
            "finished_at": runner.utc_now(),
            "task_id": state["task_id"],
            "stage": "user_profile",
            "status": "succeeded",
            "api_code": profile_response.code,
            "explicit_business_profile": bool(candidate),
        }
    )
    return {"shortcode": shortcode, "events": events, "candidate": candidate, "profile_attempted": True}


def enrich_task(
    *,
    client: Any,
    state: dict[str, Any],
    route: dict[str, Any],
    commands: Path,
    token: str,
    max_posts: int | None,
    parallelism: int,
) -> dict[str, Any]:
    state["started_at"] = state.get("started_at") or runner.utc_now()
    state = collect_discovery(client, state, route, commands, token)
    if state["status"] in runner.BLOCKING_STATUSES | {"failed_transport", "failed_business_error"}:
        return state
    state["status"] = "running"
    shortcodes = state["post_shortcodes"][:max_posts] if max_posts is not None else state["post_shortcodes"]
    completed = set(state.get("completed_post_shortcodes", []))
    candidates = list(state.get("candidates", []))
    seen_accounts = {str(candidate.get("account_handle", "")).lower() for candidate in candidates}
    remaining = [shortcode for shortcode in shortcodes if shortcode not in completed]
    first_error: dict[str, Any] | None = None
    with ThreadPoolExecutor(max_workers=parallelism) as executor:
        futures = [executor.submit(enrich_one_post, client, state, route, shortcode, token) for shortcode in remaining]
        for future in as_completed(futures):
            result = future.result()
            for event in result["events"]:
                append_command(commands, event)
            state["post_details_attempted"] += 1
            if result.get("profile_attempted"):
                state["profiles_attempted"] += 1
            if result.get("error"):
                if first_error is None:
                    first_error = result["error"]
            else:
                completed.add(result["shortcode"])
                candidate = result.get("candidate")
                if candidate and candidate["account_handle"].lower() not in seen_accounts:
                    candidates.append(candidate)
                    seen_accounts.add(candidate["account_handle"].lower())
            state["completed_post_shortcodes"] = sorted(completed)
            state["candidates"] = candidates
            state["candidate_count"] = len(candidates)
            runner.atomic_write_json(Path(state["_path"]), state)

    if first_error:
        return set_error(state, first_error)

    state["completed_post_shortcodes"] = sorted(completed)
    state["candidates"] = candidates
    state["candidate_count"] = len(candidates)
    state["status"] = "succeeded"
    state["finished_at"] = runner.utc_now()
    return state


def update_outputs(output: Path, task_states: list[dict[str, Any]], lock: dict[str, Any], max_posts: int | None) -> dict[str, Any]:
    base_candidates_path = output / "social-media-candidates.json"
    existing = runner.read_json(base_candidates_path) if base_candidates_path.is_file() else {"candidates": []}
    merged_states = [{"candidates": existing.get("candidates", [])}] + task_states
    candidates = runner.merge_candidates(merged_states)
    runner.atomic_write_json(
        base_candidates_path,
        {
            "schema_version": "clue.data-collection.social-media-candidates.v1",
            "collection_id": runner.read_json(output / "input.snapshot.json").get("collection_id"),
            "source_type": "social_media",
            "generated_at": runner.utc_now(),
            "candidate_count": len(candidates),
            "candidate_policy": {
                "retain_only_explicit_business_accounts": True,
                "exclude_comments": True,
                "exclude_media": True,
                "exclude_private_contact_data": True,
                "official_website_verification_required": True,
                "post_and_profile_enrichment": True,
            },
            "candidates": candidates,
        },
    )
    counts = Counter(state["status"] for state in task_states)
    if counts.get("blocked_insufficient_credit"):
        status = "blocked_insufficient_credit"
    elif any(counts.get(item) for item in ("blocked_authentication", "blocked_permission", "blocked_rate_limit")):
        status = next(item for item in ("blocked_authentication", "blocked_permission", "blocked_rate_limit") if counts.get(item))
    elif any(key.startswith("failed_") for key in counts):
        status = "completed_with_errors"
    else:
        status = "succeeded"
    summary = {
        "schema_version": "clue-justoneapi-cli.enrichment-run.v1",
        "status": status,
        "generated_at": runner.utc_now(),
        "backend_commit": lock["backend"]["commit"],
        "max_post_details_per_task": max_posts,
        "task_status_counts": dict(sorted(counts.items())),
        "business_candidate_count": len(candidates),
        "resume_hint": f"clue-justoneapi-cli enrich --output {output}" if status != "succeeded" else None,
    }
    runner.atomic_write_json(output / "enrichment" / "run.json", summary)
    for state in task_states:
        state_candidates = [
            candidate for candidate in candidates if state["task_id"] in candidate.get("task_ids", [])
        ]
        state["candidates"] = state_candidates
        state["candidate_count"] = len(state_candidates)
        runner.atomic_write_json(output / "enrichment" / "tasks" / f"{state['task_id']}.json", state)
    existing_run = runner.read_json(output / "run.json")
    existing_run["business_candidate_count"] = len(candidates)
    existing_run["enrichment"] = {"status": status, "path": "enrichment/run.json", "business_candidate_count": len(candidates)}
    runner.atomic_write_json(output / "run.json", existing_run)
    return summary


def run_enrichment(root: Path, output: Path, token_file: Path | str, max_posts: int | None, parallelism: int) -> int:
    lock, routes, _ = runner.load_configuration(root)
    runner.assert_backend(root, lock)
    snapshot = output / "input.snapshot.json"
    if not snapshot.is_file():
        raise runner.CliError(f"input snapshot is missing: {snapshot}")
    input_document = runner.read_json(snapshot)
    descriptors = runner.extract_tasks(input_document, routes)
    enrichment_dir = output / "enrichment"
    enrichment_dir.mkdir(parents=True, exist_ok=True)
    if not (enrichment_dir / "execution-log.md").exists():
        write_log_header(enrichment_dir, lock, token_file, max_posts)
    token = runner.load_token(token_file)
    Client = runner.import_sdk(root, lock)
    client = Client(token=token, base_url=lock["backend"]["api_base_url"], timeout=int(lock["run_defaults"]["request_timeout_seconds"]))
    states: list[dict[str, Any]] = []
    global_block: str | None = None
    commands = enrichment_dir / "commands.jsonl"
    try:
        for descriptor in descriptors:
            task = descriptor["task"]
            route = descriptor["route"]
            if route is None or not route.get("account_enrichment", {}).get("enabled"):
                continue
            state_path = enrichment_dir / "tasks" / f"{task['task_id']}.json"
            state = runner.read_json(state_path) if state_path.is_file() else enrichment_template(task, route, descriptor["normalized_query"])
            state["_path"] = str(state_path)
            if global_block:
                state["status"] = "pending"
                state["last_error"] = {"classification": "not_attempted_after_run_block", "blocked_by": global_block, "resume_required": True}
            else:
                state = enrich_task(client=client, state=state, route=route, commands=commands, token=token, max_posts=max_posts, parallelism=parallelism)
                if state["status"] in runner.BLOCKING_STATUSES | {"failed_transport", "failed_business_error"}:
                    global_block = state["status"]
            state.pop("_path", None)
            runner.atomic_write_json(state_path, state)
            states.append(state)
    finally:
        client.close()
    summary = update_outputs(output, states, lock, max_posts)
    with (enrichment_dir / "execution-log.md").open("a", encoding="utf-8") as handle:
        for state in states:
            handle.write(f"- `{state['task_id']}` — `{state['status']}`，已补全帖子 `{len(state.get('completed_post_shortcodes', []))}`，企业账号候选 `{state.get('candidate_count', 0)}`。\n")
        handle.write(f"\n- 汇总状态：`{summary['status']}`；企业账号候选：`{summary['business_candidate_count']}`。\n")
    runner.print_json({"status": summary["status"], "output": str(output), "business_candidate_count": summary["business_candidate_count"], "task_status_counts": summary["task_status_counts"], "resume_hint": summary["resume_hint"]})
    return 75 if summary["status"] == "blocked_insufficient_credit" else (0 if summary["status"] == "succeeded" else 1)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="clue-justoneapi-cli enrich")
    parser.add_argument("--root", required=True)
    parser.add_argument("--workspace", help="Customer workspace ID. Resolves --run-id below acquisition/customer-data-collection/runs/.")
    parser.add_argument("--workspaces-root", help="Override POLARIS_LITERATURE_WORKSPACES_ROOT for --workspace.")
    parser.add_argument("--run-id", help="Existing social-media run ID when --workspace is used.")
    parser.add_argument("--output", help="Existing social-media output directory.")
    parser.add_argument("--token-file")
    parser.add_argument("--max-post-details-per-task", type=runner.parse_positive_integer)
    parser.add_argument("--parallelism", type=runner.parse_positive_integer, default=4)
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    lock, _, _ = runner.load_configuration(root)
    if args.workspaces_root and not args.workspace:
        raise runner.CliError("--workspaces-root requires --workspace")
    if args.run_id and not args.workspace:
        raise runner.CliError("--run-id requires --workspace")
    if args.run_id and args.output:
        raise runner.CliError("--output and --run-id cannot be used together")
    if args.workspace and not args.output:
        if not args.run_id:
            raise runner.CliError("--run-id is required with --workspace when --output is omitted")
        if not runner.RUN_ID_PATTERN.fullmatch(args.run_id):
            raise runner.CliError("--run-id may contain only letters, numbers, dot, underscore and hyphen")
        if runner.collection_paths is None:
            raise runner.CliError("workspace path helper is unavailable")
        try:
            args.output = str(runner.collection_paths(args.workspace, args.workspaces_root).runs / args.run_id)
        except runner.WorkspacePathError as error:
            raise runner.CliError(str(error)) from error
    if not args.output:
        raise runner.CliError("--output is required unless --workspace is used with --run-id")
    if args.token_file == "-":
        token_file: Path | str = "-"
    elif args.token_file:
        token_file = runner.absolute_path(args.token_file)
    else:
        token_file = runner.default_token_file(root, lock)
    output = runner.absolute_path(args.output)
    if not output.is_dir():
        raise runner.CliError(f"output directory is missing: {output}")
    return run_enrichment(root, output, token_file, args.max_post_details_per_task, args.parallelism)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except runner.CliError as exc:
        print(f"error: {runner.safe_text(exc, limit=500)}", file=sys.stderr)
        raise SystemExit(1)
