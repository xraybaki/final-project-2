"""
Central configuration for the convoy route-planner pipeline.

Switch the operating area by editing REGION_NAME / CENTER / RADIUS_M and re-running
    python -m pipeline.run_all
(delete data/cache/ first if you change the area).
"""
from pathlib import Path

# ---------------------------------------------------------------- operating area
REGION_NAME = "Dehradun, Uttarakhand"
CENTER = (30.3165, 78.0322)        # (lat, lon) - Clock Tower area
RADIUS_M = 12_000                  # download radius around CENTER
NETWORK_TYPE = "drive"

# ---------------------------------------------------------------- convoy parameters
CONVOY_SPEED_KMPH = 30             # average convoy speed used for ETA / exposure time
THREAT_ZONE_RADIUS_M = 300         # default radius of a live threat zone
HARD_BLOCK_IMPACT = 90             # impact >= this -> road closed to convoy (infinite cost)
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
LEGACY_DIR = ROOT / "legacy_toronto"

GRAPHML_CACHE = CACHE_DIR / "graph.graphml"
INCIDENTS_CSV = DATA_DIR / "incidents.csv"
LIVE_THREATS_JSON = DATA_DIR / "live_threats.json"
REGION_JSON = DATA_DIR / "region.json"      # tells the frontend where to centre the map

ROUTING_GRAPH_JSON = ROOT / "routing_graph.json"
ROUTING_EDGES_GEOJSON = ROOT / "routing_edges.geojson"
ROUTING_EDGES_CSV = ROOT / "routing_edges.csv"

SYNTHETIC_LABEL = "SYNTHETIC - for demonstration only"

for _d in (DATA_DIR, CACHE_DIR, MODELS_DIR, REPORTS_DIR):
    _d.mkdir(parents=True, exist_ok=True)
