"""
SITREP parser: free-text threat report -> {lat, lon, type, impact, location, description, parser}.

Reads JSON {"text": "..."} on stdin, prints JSON on stdout.

1. If GEMINI_API_KEY is set and `google-genai` is installed, Gemini extracts the fields
   (threat type, impact, street / place name, offsets) as JSON.
2. Otherwise (or on ANY error) a rule-based keyword parser is used.
Either way the location is resolved offline against OSM street names in routing_graph.json,
so the demo never depends on the AI call.

(The original Toronto news-scraping chat assistant lives in legacy_toronto/gemini_api.py.)
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TYPES = ["IED", "ambush", "stone_pelting", "road_blockade", "landslide", "accident"]
DEFAULT_IMPACT = {"IED": 92, "ambush": 80, "stone_pelting": 60, "road_blockade": 70,
                  "landslide": 95, "accident": 45}
KEYWORDS = {
    "IED": ["ied", "bomb", "explosive", "suspicious object", "unattended object", "device", "pressure cooker"],
    "ambush": ["ambush", "firing", "gunmen", "gunfire", "sniper", "armed men", "militant", "shots"],
    "stone_pelting": ["stone", "pelting", "mob", "crowd", "riot", "rioters"],
    "road_blockade": ["blockade", "protest", "dharna", "chakka jam", "sit-in", "barricade", "agitation"],
    "landslide": ["landslide", "debris", "slope", "rockfall", "rock fall", "mudslide", "boulders"],
    "accident": ["accident", "collision", "overturned", "crash", "truck stuck", "breakdown"],
}
DIRS = {"north": (0, 1), "south": (0, -1), "east": (1, 0), "west": (-1, 0),
        "northeast": (0.707, 0.707), "north-east": (0.707, 0.707), "northwest": (-0.707, 0.707),
        "north-west": (-0.707, 0.707), "southeast": (0.707, -0.707), "south-east": (0.707, -0.707),
        "southwest": (-0.707, -0.707), "south-west": (-0.707, -0.707)}


# --------------------------------------------------------------------------- gazetteer
def load_gazetteer():
    g = json.loads((ROOT / "routing_graph.json").read_text())
    nodes = {n["id"]: n for n in g["nodes"]}
    streets: dict[str, list] = {}
    for e in g["edges"]:
        name = e.get("street_name") or ""
        if not name or name.lower() == "unnamed road":
            continue
        a, b = nodes[e["source"]], nodes[e["target"]]
        streets.setdefault(name, []).append({
            "lat": (a["lat"] + b["lat"]) / 2, "lon": (a["lon"] + b["lon"]) / 2,
            "bridge": e.get("bridge", False), "length": e["length_m"]})
    center = g.get("meta", {}).get("region", {}).get("center")
    return streets, center


def _norm(s: str) -> str:
    s = s.lower()
    s = re.sub(r"\b(rd)\b", "road", s)
    s = re.sub(r"\b(st)\b", "street", s)
    s = re.sub(r"\b(marg)\b", "marg", s)
    return re.sub(r"[^a-z0-9 ]+", " ", s).strip()


def find_street(text: str, streets: dict):
    t = " " + _norm(text) + " "
    best = None
    for name in streets:
        n = _norm(name)
        if len(n) < 4:
            continue
        if f" {n} " in t and (best is None or len(n) > len(_norm(best))):
            best = name
    if best:
        return best
    # fallback: match the distinctive first word(s) of a street ("boulevard" -> "Boulevard Road")
    for name in sorted(streets, key=lambda s: -sum(x["length"] for x in streets[s])):
        first = _norm(name).split(" ")[0]
        if len(first) >= 5 and re.search(rf"\b{re.escape(first)}\b", t):
            return name
    return None


def place_on_street(name: str, streets: dict, prefer_bridge: bool):
    segs = streets[name]
    if prefer_bridge and any(s["bridge"] for s in segs):
        segs = [s for s in segs if s["bridge"]]
    clat = sum(s["lat"] for s in segs) / len(segs)
    clon = sum(s["lon"] for s in segs) / len(segs)
    s = min(segs, key=lambda s: (s["lat"] - clat) ** 2 + (s["lon"] - clon) ** 2)
    return s["lat"], s["lon"]


def apply_offset(lat, lon, km, direction):
    dx, dy = DIRS.get(direction.lower(), (0, 0))
    return (lat + dy * km * 1000 / 110540,
            lon + dx * km * 1000 / (111320 * math.cos(math.radians(lat))))


# --------------------------------------------------------------------------- parsers
def rule_based(text: str) -> dict:
    t = text.lower()
    scores = {k: sum(t.count(w) for w in ws) for k, ws in KEYWORDS.items()}
    itype = max(scores, key=scores.get) if max(scores.values()) > 0 else "road_blockade"
    impact = DEFAULT_IMPACT[itype]
    if re.search(r"\b(suspected|unconfirmed|possible|reported)\b", t):
        impact -= 4
    if re.search(r"\b(confirmed|multiple|heavy)\b", t):
        impact += 5
    if re.search(r"\b(road closed|completely blocked|fully blocked|impassable)\b", t):
        impact = max(impact, 92)
    out = {"type": itype, "impact": int(max(10, min(100, impact))), "offset_km": None,
           "direction": None, "street": None}
    m = re.search(r"(\d+(?:\.\d+)?)\s*(km|kilomet\w*|m|metres|meters)\s+"
                  r"(north-?east|north-?west|south-?east|south-?west|north|south|east|west)", t)
    if m:
        val = float(m.group(1))
        out["offset_km"] = val if m.group(2).startswith("k") else val / 1000
        out["direction"] = m.group(3)
    return out


def gemini(text: str) -> dict | None:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore

        client = genai.Client(api_key=key)
        prompt = (
            "Extract a structured threat report from this convoy SITREP. Respond with ONLY JSON "
            "with keys: type (one of " + ", ".join(TYPES) + "), impact (integer 10-100; >=90 means the "
            "road is impassable), street (the road / place name exactly as written, or null), "
            "offset_km (number or null), direction (north/south/east/west/... or null), "
            "description (one neutral sentence).\nSITREP: " + text)
        resp = client.models.generate_content(
            model=os.getenv("GEMINI_MODEL", "gemini-2.0-flash"), contents=prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0))
        data = json.loads(resp.text)
        if data.get("type") not in TYPES:
            return None
        data["impact"] = int(max(10, min(100, int(data.get("impact", DEFAULT_IMPACT[data["type"]])))))
        return data
    except Exception as exc:  # noqa: BLE001 - never break the demo
        print(f"gemini failed: {exc!r}", file=sys.stderr)
        return None


def parse(text: str) -> dict:
    streets, center = load_gazetteer()
    fields = gemini(text)
    parser = "gemini"
    if fields is None:
        fields = rule_based(text)
        parser = "rule-based (no GEMINI_API_KEY or AI call failed)" if not os.getenv("GEMINI_API_KEY") else "rule-based (AI call failed)"

    lat = lon = None
    location = None
    m = re.search(r"(-?\d{1,2}\.\d{3,})\s*[, ]\s*(-?\d{1,3}\.\d{3,})", text)
    if m:
        lat, lon, location = float(m.group(1)), float(m.group(2)), f"{m.group(1)}, {m.group(2)}"
    else:
        street = None
        if fields.get("street"):
            street = find_street(fields["street"], streets)
        street = street or find_street(text, streets)
        if street:
            lat, lon = place_on_street(street, streets, "bridge" in text.lower())
            location = street + (" (bridge)" if "bridge" in text.lower() else "")
    if lat is None:
        return {"error": "Could not match any road name in the SITREP. Mention a road name from the map "
                         "(e.g. 'Boulevard Road') or give coordinates 'lat, lon'.", "parser": parser}
    if fields.get("offset_km") and fields.get("direction"):
        lat, lon = apply_offset(lat, lon, float(fields["offset_km"]), fields["direction"])
        location += f" (+{fields['offset_km']} km {fields['direction']})"
    desc = fields.get("description") or f"Parsed from SITREP: \"{text.strip()[:200]}\""
    return {"lat": round(lat, 6), "lon": round(lon, 6), "type": fields["type"],
            "impact": int(fields["impact"]), "location": location,
            "description": desc + " (SYNTHETIC scenario)", "parser": parser}


if __name__ == "__main__":
    try:
        from dotenv import load_dotenv  # type: ignore
        load_dotenv()
    except Exception:  # noqa: BLE001
        pass
    payload = json.load(sys.stdin)
    print(json.dumps(parse(payload.get("text", ""))))
