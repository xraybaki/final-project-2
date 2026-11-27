"""
Central configuration for the convoy route-planner pipeline.

Switch the operating area by editing REGION_NAME / CENTER / RADIUS_M and re-running
    python -m pipeline.run_all
(delete data/cache/ first if you change the area).
"""
from pathlib import Path

# ---------------------------------------------------------------- operating area
REGION_NAME = "Srinagar, Jammu & Kashmir"
CENTER = (34.0837, 74.7973)        # (lat, lon) - Srinagar city centre
RADIUS_M = 12_000                  # half-width of the download box around CENTER
NETWORK_TYPE = "drive"
# Fallback source if the Overpass API is unreachable: a regional OSM extract (.osm.pbf)
# that is clipped to the box above. Set to None to skip. Must cover CENTER.
OSM_EXTRACT_URL = "https://download.openstreetmap.fr/extracts/asia/india/jammu_and_kashmir-latest.osm.pbf"
# Previous default (Uttarakhand extract for Dehradun):
#   REGION_NAME = "Dehradun, Uttarakhand"; CENTER = (30.3165, 78.0322)
#   OSM_EXTRACT_URL = "https://download.openstreetmap.fr/extracts/asia/india/uttarakhand-latest.osm.pbf"

# ---------------------------------------------------------------- convoy parameters
CONVOY_SPEED_KMPH = 30             # average convoy speed used for ETA / exposure time
# Live-threat defaults come from threat_types.json (shared with the frontend + SITREP resolver)
import json as _json
_TT = _json.loads((Path(__file__).resolve().parent.parent / "threat_types.json").read_text(encoding="utf-8"))
THREAT_DEFAULT_RADIUS_M = {k: v["radius_m"] for k, v in _TT["types"].items()}
THREAT_DEFAULT_IMPACT = {k: v["impact"] for k, v in _TT["types"].items()}
THREAT_RADIUS_RANGE_M = (_TT["radius_min_m"], _TT["radius_max_m"])
HARD_BLOCK_IMPACT = _TT["hard_block_impact"]  # impact >= this -> road closed (infinite cost)
HIGH_RISK_WEIGHT = 60              # edge weight >= this counts as "high-risk" exposure
CHOKEPOINT_TOP_PCT = 5             # top-N% edge betweenness flagged as chokepoints

# ---------------------------------------------------------------- synthetic data
RANDOM_SEED = 42
N_HOTSPOTS = 10                    # 8-12 clusters
N_INCIDENTS = None                 # total synthetic incidents over 24 months (None = auto: ~4 per 100 edges)
HISTORY_MONTHS = 24
FEATURE_MONTHS = 18                # months 1-18 -> features, 19-24 -> label
LABEL_RADIUS_M = 150               # edge is "risky" if a future incident is within this

# ---------------------------------------------------------------- model
MODEL_CHOICE = "xgboost"           # "xgboost" | "gbm" | "rf" ; falls back automatically
BETWEENNESS_K = 500                # sample size for approximate edge betweenness

# ---------------------------------------------------------------- paths
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
MODELS_DIR = ROOT / "models"
REPORTS_DIR = ROOT / "reports"

GRAPHML_CACHE = CACHE_DIR / "graph.graphml"
INCIDENTS_CSV = DATA_DIR / "incidents.csv"
LIVE_THREATS_JSON = DATA_DIR / "live_threats.json"
REGION_JSON = DATA_DIR / "region.json"      # tells the frontend where to centre the map
LANDMARKS_JSON = DATA_DIR / "landmarks.json"  # named OSM places for SITREP resolution

ROUTING_GRAPH_JSON = ROOT / "routing_graph.json"
ROUTING_EDGES_GEOJSON = ROOT / "routing_edges.geojson"
ROUTING_EDGES_CSV = ROOT / "routing_edges.csv"

SYNTHETIC_LABEL = "SYNTHETIC - for demonstration only"

for _d in (DATA_DIR, CACHE_DIR, MODELS_DIR, REPORTS_DIR):
    _d.mkdir(parents=True, exist_ok=True)
