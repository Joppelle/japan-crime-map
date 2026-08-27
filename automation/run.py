import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


API_KEY = os.environ.get("DEVIN_API_KEY")
ORG_ID = os.environ.get("DEVIN_ORG_ID")
REPOSITORY = os.environ.get("GITHUB_REPOSITORY", "Joppelle/japan-crime-map")
ROOT = Path(__file__).resolve().parents[1]
TAG = "japan-crime-map-ingestion"


def request(method, url, payload=None):
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    body = json.dumps(payload).encode() if payload is not None else None
    with urllib.request.urlopen(
        urllib.request.Request(url, data=body, headers=headers, method=method), timeout=30
    ) as response:
        return json.load(response)


def active_session():
    query = urllib.parse.urlencode({"limit": 100, "tags": TAG})
    response = request("GET", f"https://api.devin.ai/v1/sessions?{query}")
    active_statuses = {"working", "blocked", "resumed", "resume_requested"}
    return next(
        (session for session in response["sessions"] if session.get("status_enum") in active_statuses),
        None,
    )


def select_prefecture():
    inventory = json.loads((ROOT / "data" / "sources.json").read_text())
    requested = os.environ.get("PREFECTURE")
    candidates = [
        prefecture
        for prefecture in inventory["prefectures"]
        if prefecture["adapter"] == "pending"
    ]
    if requested:
        return next(
            (prefecture for prefecture in inventory["prefectures"] if prefecture["name"] == requested),
            None,
        )
    return candidates[int(time.time() // 86400) % len(candidates)] if candidates else None


def main():
    if not API_KEY or not ORG_ID:
        sys.exit("DEVIN_API_KEY and DEVIN_ORG_ID are required")
    running = active_session()
    if running:
        print(f"An ingestion session is already active: {running['session_id']}")
        return
    prefecture = select_prefecture()
    if not prefecture:
        print("No pending prefecture adapter found")
        return
    prompt = f"""
Extend the Japan crime map ingestion system for {prefecture["name"]}.

Repository: {REPOSITORY}
Official landing page: {prefecture["landingUrl"]}

Inspect the landing page and current downloadable files in the browser. Verify meaning from page
context and headers, not filenames alone. Implement or improve the narrowest reusable adapter family
in this repository. Archive source provenance, normalize records to the existing schema, and never
represent derived geometry as exact incident coordinates. Preserve the privacy threshold and the
town/chome-to-municipality fallback. Run lint, type checking, data validation, and build. Update
data/sources.json only after the adapter works against a real current file, then open a focused PR.
Do not change the UI unless the adapter requires a backward-compatible schema addition.
""".strip()
    payload = {
        "prompt": prompt,
        "repos": [REPOSITORY],
        "devin_mode": "normal",
        "max_acu_limit": 15,
        "resumable": True,
        "tags": [TAG, f"prefecture-{prefecture['code']}"],
        "title": f"Add {prefecture['name']} crime-data adapter",
    }
    session = request(
        "POST", f"https://api.devin.ai/v3/organizations/{ORG_ID}/sessions", payload
    )
    print(session["url"])


if __name__ == "__main__":
    main()
