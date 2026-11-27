"""
SITREP parser entry point (spawned by server.js for POST /parse-sitrep).

Reads JSON {"text": "..."} on stdin and prints one JSON object on stdout:
  {"status": "ok", lat, lon, type, impact, radius_m, location_label, resolution, confidence, ...}
  {"status": "needs_pin", street, street_eids, ...}   - road named but no exact point
  {"status": "error", message, ...}

1. If GEMINI_API_KEY is set and `google-genai` is installed, Gemini extracts the *fields*
   (type, impact, radius, street, junction_with, landmark, offset, direction, description).
2. Otherwise, or on ANY error, rule-based regexes extract the same fields.
Location is ALWAYS resolved offline by sitrep_resolver.py against OSM roads and landmarks;
coordinates proposed by the AI are never used.
"""
from __future__ import annotations

import json
import os
import sys

import sitrep_resolver as R


def gemini_fields(text: str) -> dict | None:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore

        client = genai.Client(api_key=key)
        prompt = (
            "Extract a structured threat report from this convoy SITREP. Respond with ONLY JSON with keys: "
            "type (one of " + ", ".join(R.THREAT_TYPES) + "), impact (integer 10-100; >=90 means the road is "
            "impassable), radius_m (integer metres or null), street (road name exactly as written, or null), "
            "junction_with (second road name if the location is a junction of two roads, else null), "
            "landmark (named place / bridge / chowk / building exactly as written, or null), "
            "offset_m (number of metres from the landmark or junction, or null), "
            "direction (north/south/east/west/northeast/... or null), "
            "description (one neutral sentence). Do NOT output coordinates.\nSITREP: " + text)
        resp = client.models.generate_content(
            model=os.getenv("GEMINI_MODEL", "gemini-2.0-flash"), contents=prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0))
        data = json.loads(resp.text)
        if data.get("type") not in R.THREAT_TYPES:
            return None
        return data
    except Exception as exc:  # noqa: BLE001 - never break the demo
        print(f"gemini failed: {exc!r}", file=sys.stderr)
        return None


def parse(text: str) -> dict:
    fields = gemini_fields(text)
    if fields is not None:
        parser = "gemini (fields) + offline gazetteer"
    elif os.getenv("GEMINI_API_KEY"):
        parser = "rule-based (AI call failed)"
    else:
        parser = "rule-based (no GEMINI_API_KEY)"
    return R.resolve(text, fields, parser)


if __name__ == "__main__":
    try:
        from dotenv import load_dotenv  # type: ignore
        load_dotenv()
    except Exception:  # noqa: BLE001
        pass
    sys.stdout.reconfigure(encoding="utf-8")
    payload = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    print(json.dumps(parse(payload.get("text", "")), ensure_ascii=False))
