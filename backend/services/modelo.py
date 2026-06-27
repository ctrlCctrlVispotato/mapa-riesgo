"""Carga y usa el modelo de predicción para estimar hotspots y zonas de riesgo."""

import json
import pickle
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

try:
    from backend.services.limpieza import PROJECT_ROOT
except ImportError:
    from services.limpieza import PROJECT_ROOT

# ──────────────────────────────────────────────
# Paths & constants
# ──────────────────────────────────────────────
MODELS_DIR = PROJECT_ROOT / "models"
MODEL_PATH = MODELS_DIR / "hotspot_model.pkl"
METADATA_PATH = MODELS_DIR / "hotspot_model_metadata.json"

GRID_SIZE_DEGREES = 0.01
EVAL_COVERAGE_RADIUS_CELLS = 1
EVAL_MAX_HOTSPOTS_PER_WINDOW = 5
EVAL_ZONE_HOTSPOTS = 8

# Features used by the Random Forest
RF_FEATURE_COLUMNS = [
    "grid_lat",
    "grid_lon",
    "hora",
    "mes",
    "dia_semana",
    "hour_sin",
    "hour_cos",
    "month_sin",
    "month_cos",
    "dow_sin",
    "dow_cos",
    "hour_x_dow",           # NEW: hour × day-of-week interaction
    "cell_count",
    "cell_hour_count",
    "cell_month_count",
    "cell_day_count",
    "hour_count",
    "month_count",
    "day_count",
    "nearby_cell_count",
    "nearby_cell_hour_count",
]

# ──────────────────────────────────────────────
# Low-level helpers
# ──────────────────────────────────────────────

def _ensure_datetime_fields(df):
    df = df.copy()
    df["fecha"] = pd.to_datetime(df["fecha"], errors="coerce")
    df["hora"] = pd.to_numeric(df["hora"], errors="coerce").fillna(0).astype(int)
    df["dia_semana"] = pd.to_numeric(df["dia_semana"], errors="coerce").fillna(0).astype(int)
    if "mes" not in df.columns:
        df["mes"] = df["fecha"].dt.month
    df["mes"] = pd.to_numeric(df["mes"], errors="coerce").fillna(df["fecha"].dt.month).astype(int)
    return df.dropna(subset=["fecha", "latitud", "longitud"])


def _extract_day_month(df, target_date=None):
    if target_date is not None:
        target_ts = pd.to_datetime(target_date, errors="coerce")
        if pd.notna(target_ts):
            return int(target_ts.month), int(target_ts.dayofweek)
    month_mode = df["mes"].mode().iloc[0] if "mes" in df.columns and not df["mes"].mode().empty else pd.Timestamp.utcnow().month
    day_mode = df["dia_semana"].mode().iloc[0] if "dia_semana" in df.columns and not df["dia_semana"].mode().empty else pd.Timestamp.utcnow().dayofweek
    return int(month_mode), int(day_mode)


def _add_grid_columns(df, grid_size=GRID_SIZE_DEGREES):
    df = df.copy()
    df["grid_lat"] = (np.floor(df["latitud"] / grid_size) * grid_size + grid_size / 2).round(6)
    df["grid_lon"] = (np.floor(df["longitud"] / grid_size) * grid_size + grid_size / 2).round(6)
    return df


def _cyclical_encoding(value, period):
    angle = 2 * np.pi * (float(value) % float(period)) / float(period)
    return float(np.sin(angle)), float(np.cos(angle))


def _max_or_one(values):
    return float(max(values)) if len(values) else 1.0


def _lookup_count(mapping, key, default=0):
    return int(mapping.get(tuple(key), default))


# ──────────────────────────────────────────────
# FIX 4: pre-indexed neighbor lookup (O(1) per cell)
# ──────────────────────────────────────────────

def _build_neighbor_index(cell_counts, grid_size, radius=1):
    """
    Pre-compute weighted neighborhood sums for every observed cell so that
    _build_rf_feature_row does not have to scan the entire dictionary each time.
    Returns a dict: cell_key -> weighted_sum.
    """
    observed_cells = {(float(key[0]), float(key[1])) for key in cell_counts.keys()}
    index = {cell: 0.0 for cell in observed_cells}
    offsets = range(-int(radius), int(radius) + 1)

    for raw_key, count in cell_counts.items():
        src_lat, src_lon = float(raw_key[0]), float(raw_key[1])
        for d_lat in offsets:
            for d_lon in offsets:
                target = (round(src_lat + d_lat * grid_size, 6), round(src_lon + d_lon * grid_size, 6))
                if target not in observed_cells:
                    continue
                dist = max(abs(d_lat), abs(d_lon))
                weight = 1.0 if dist == 0 else 1.0 / (1.0 + dist)
                index[target] += float(count) * weight
    return index


def _build_neighbor_hour_index(cell_hour_counts, grid_size, radius=1):
    """
    Pre-compute weighted neighborhood hour sums keyed by (cell_key, hour).
    """
    index = defaultdict(float)
    cells_by_hour = defaultdict(set)
    for raw_key in cell_hour_counts.keys():
        cells_by_hour[int(raw_key[2])].add((float(raw_key[0]), float(raw_key[1])))

    offsets = range(-int(radius), int(radius) + 1)
    for raw_key, count in cell_hour_counts.items():
        src_lat, src_lon, hour = float(raw_key[0]), float(raw_key[1]), int(raw_key[2])
        observed_hour_cells = cells_by_hour[hour]
        for d_lat in offsets:
            for d_lon in offsets:
                target = (round(src_lat + d_lat * grid_size, 6), round(src_lon + d_lon * grid_size, 6))
                if target not in observed_hour_cells:
                    continue
                dist = max(abs(d_lat), abs(d_lon))
                weight = 1.0 if dist == 0 else 1.0 / (1.0 + dist)
                index[(target[0], target[1], hour)] += float(count) * weight
    return dict(index)


# ──────────────────────────────────────────────
# Training statistics
# ──────────────────────────────────────────────

def _build_training_stats(df, grid_size):
    prepared = _ensure_datetime_fields(df)
    prepared = _add_grid_columns(prepared, grid_size=grid_size)

    cell_counts = prepared.groupby(["grid_lat", "grid_lon"]).size().to_dict()
    cell_hour_counts = prepared.groupby(["grid_lat", "grid_lon", "hora"]).size().to_dict()
    cell_month_counts = prepared.groupby(["grid_lat", "grid_lon", "mes"]).size().to_dict()
    cell_day_counts = prepared.groupby(["grid_lat", "grid_lon", "dia_semana"]).size().to_dict()

    # FIX 4: build neighbor indexes once at training time
    neighbor_index = _build_neighbor_index(cell_counts, grid_size, radius=1)
    neighbor_hour_index = _build_neighbor_hour_index(cell_hour_counts, grid_size, radius=1)

    stats = {
        "cell_counts": cell_counts,
        "cell_hour_counts": cell_hour_counts,
        "cell_month_counts": cell_month_counts,
        "cell_day_counts": cell_day_counts,
        "hour_counts": prepared.groupby("hora").size().to_dict(),
        "month_counts": prepared.groupby("mes").size().to_dict(),
        "day_counts": prepared.groupby("dia_semana").size().to_dict(),
        "neighbor_index": neighbor_index,
        "neighbor_hour_index": neighbor_hour_index,
        "max_cell_count": _max_or_one(list(cell_counts.values())),
        "max_cell_hour_count": _max_or_one(list(cell_hour_counts.values())),
        "max_cell_month_count": _max_or_one(list(cell_month_counts.values())),
        "max_cell_day_count": _max_or_one(list(cell_day_counts.values())),
        "max_hour_count": _max_or_one(prepared.groupby("hora").size().values),
        "max_month_count": _max_or_one(prepared.groupby("mes").size().values),
        "max_day_count": _max_or_one(prepared.groupby("dia_semana").size().values),
        "grid_size_degrees": grid_size,
        "prepared_rows": int(len(prepared)),
    }
    return prepared, stats


# ──────────────────────────────────────────────
# Feature row builder
# ──────────────────────────────────────────────

def _build_rf_feature_row(stats, cell_key, hour, month, day_of_week):
    cell_count = _lookup_count(stats["cell_counts"], cell_key, 0)
    cell_hour_count = _lookup_count(stats["cell_hour_counts"], (*cell_key, hour), 0)
    cell_month_count = _lookup_count(stats["cell_month_counts"], (*cell_key, month), 0)
    cell_day_count = _lookup_count(stats["cell_day_counts"], (*cell_key, day_of_week), 0)
    hour_count = int(stats["hour_counts"].get(int(hour), 0))
    month_count = int(stats["month_counts"].get(int(month), 0))
    day_count = int(stats["day_counts"].get(int(day_of_week), 0))

    # FIX 4: use pre-built indexes instead of scanning every key
    nearby_cell_count = float(stats["neighbor_index"].get(tuple(cell_key), 0.0))
    nearby_cell_hour_count = float(stats["neighbor_hour_index"].get((*cell_key, int(hour)), 0.0))

    hour_sin, hour_cos = _cyclical_encoding(hour, 24)
    month_sin, month_cos = _cyclical_encoding(month, 12)
    dow_sin, dow_cos = _cyclical_encoding(day_of_week, 7)

    # FIX 8: hour × day-of-week interaction feature
    hour_x_dow = int(hour) * 7 + int(day_of_week)

    return {
        "grid_lat": float(cell_key[0]),
        "grid_lon": float(cell_key[1]),
        "hora": int(hour),
        "mes": int(month),
        "dia_semana": int(day_of_week),
        "hour_sin": hour_sin,
        "hour_cos": hour_cos,
        "month_sin": month_sin,
        "month_cos": month_cos,
        "dow_sin": dow_sin,
        "dow_cos": dow_cos,
        "hour_x_dow": hour_x_dow,
        "cell_count": float(cell_count),
        "cell_hour_count": float(cell_hour_count),
        "cell_month_count": float(cell_month_count),
        "cell_day_count": float(cell_day_count),
        "hour_count": float(hour_count),
        "month_count": float(month_count),
        "day_count": float(day_count),
        "nearby_cell_count": float(nearby_cell_count),
        "nearby_cell_hour_count": float(nearby_cell_hour_count),
    }


# ──────────────────────────────────────────────
# Training
# ──────────────────────────────────────────────

def _train_rf_hotspot_model(df, grid_size=GRID_SIZE_DEGREES, random_state=42):
    from sklearn.ensemble import RandomForestClassifier

    prepared, stats = _build_training_stats(df, grid_size)
    if prepared.empty:
        raise ValueError("No hay suficientes datos para entrenar el modelo de hotspots.")

    grouped = (
        prepared.groupby(["grid_lat", "grid_lon", "hora", "mes", "dia_semana"], as_index=False)
        .size()
        .rename(columns={"size": "incident_count"})
    )
    if grouped.empty:
        raise ValueError("No hay suficientes ventanas temporales para entrenar el modelo de hotspots.")

    positive_keys = {
        (float(row["grid_lat"]), float(row["grid_lon"]), int(row["hora"]), int(row["mes"]), int(row["dia_semana"]))
        for _, row in grouped.iterrows()
    }

    observed_cells = (
        prepared[["grid_lat", "grid_lon"]]
        .dropna()
        .drop_duplicates()
        .to_numpy()
    )
    if len(observed_cells) == 0:
        raise ValueError("No hay celdas espaciales suficientes para entrenar el modelo de hotspots.")

    rows = []
    labels = []

    # Positive samples
    for _, row in grouped.iterrows():
        cell_key = (float(row["grid_lat"]), float(row["grid_lon"]))
        rows.append(_build_rf_feature_row(stats, cell_key, int(row["hora"]), int(row["mes"]), int(row["dia_semana"])))
        labels.append(1)

    # FIX 3: systematic negative sampling — deterministic, avoids retry loop
    all_cell_set = {(float(c[0]), float(c[1])) for c in observed_cells}
    rng = np.random.default_rng(random_state)
    negative_multiplier = 2
    for _, row in grouped.iterrows():
        hour = int(row["hora"])
        month = int(row["mes"])
        day_of_week = int(row["dia_semana"])
        # Draw from all cells, filter out positives in one pass
        candidates = [
            c for c in all_cell_set
            if (c[0], c[1], hour, month, day_of_week) not in positive_keys
        ]
        if not candidates:
            continue
        chosen = rng.choice(len(candidates), size=min(negative_multiplier, len(candidates)), replace=False)
        for idx in chosen:
            cell_key = candidates[int(idx)]
            rows.append(_build_rf_feature_row(stats, cell_key, hour, month, day_of_week))
            labels.append(0)

    training_frame = pd.DataFrame(rows, columns=RF_FEATURE_COLUMNS)
    if training_frame.empty or len(set(labels)) < 2:
        raise ValueError("No hay suficientes datos positivos y negativos para entrenar el modelo de hotspots.")

    # FIX 6: tuned hyperparameters — min_samples_leaf prevents single-sample leaves
    classifier = RandomForestClassifier(
        n_estimators=150,
        min_samples_leaf=5,
        max_features="sqrt",
        class_weight="balanced",
        n_jobs=-1,
        random_state=random_state,
    )
    classifier.fit(training_frame[RF_FEATURE_COLUMNS], labels)

    model = {
        "classifier": classifier,
        "feature_columns": RF_FEATURE_COLUMNS,
        "grid_size_degrees": grid_size,
        "training_rows": int(len(training_frame)),
        "source_rows": int(len(prepared)),
        "positive_windows": int(len(grouped)),
        **stats,
    }
    return model


# ──────────────────────────────────────────────
# Scoring
# ──────────────────────────────────────────────

def _score_candidate_grid_rf(model, candidate_grid, hour, month, day_of_week):
    if candidate_grid.empty:
        return []
    candidate_cells = [
        (float(row.grid_lat), float(row.grid_lon))
        for row in candidate_grid.itertuples(index=False)
    ]
    feature_rows = [
        _build_rf_feature_row(model, cell_key, hour, month, day_of_week)
        for cell_key in candidate_cells
    ]
    feature_frame = pd.DataFrame(feature_rows, columns=RF_FEATURE_COLUMNS)
    probabilities = model["classifier"].predict_proba(feature_frame[RF_FEATURE_COLUMNS])[:, 1]
    scored = []
    for cell_key, probability in zip(candidate_cells, probabilities):
        predicted_incidents = float(probability * max(model["max_cell_count"], 1.0))
        risk_score = float(probability * 100)
        scored.append((cell_key, predicted_incidents, risk_score))
    scored.sort(key=lambda item: item[2], reverse=True)
    return scored


def _neighbor_cell_set(cell_key, grid_size, radius=EVAL_COVERAGE_RADIUS_CELLS):
    lat, lon = float(cell_key[0]), float(cell_key[1])
    offsets = range(-int(radius), int(radius) + 1)
    return {
        (round(lat + d_lat * grid_size, 6), round(lon + d_lon * grid_size, 6))
        for d_lat in offsets
        for d_lon in offsets
    }


def _coverage_counts(predicted_cells, actual_cells, grid_size, radius=EVAL_COVERAGE_RADIUS_CELLS):
    actual_lookup = set(actual_cells)
    predicted_hits = 0
    covered_actual = set()

    for cell_key in predicted_cells:
        matched_actual = _neighbor_cell_set(cell_key, grid_size, radius) & actual_lookup
        if matched_actual:
            predicted_hits += 1
            covered_actual.update(matched_actual)

    return predicted_hits, len(covered_actual)


def _build_expected_hotspot_count_lookup(df, grid_size):
    prepared = _add_grid_columns(_ensure_datetime_fields(df), grid_size=grid_size)
    if prepared.empty:
        return {"exact": {}, "dow_hour": {}, "hour": {}, "global": 1}

    unique_cells = prepared[["fecha", "mes", "dia_semana", "hora", "grid_lat", "grid_lon"]].drop_duplicates().copy()
    unique_cells["date_key"] = unique_cells["fecha"].dt.date
    window_counts = (
        unique_cells
        .groupby(["date_key", "mes", "dia_semana", "hora"])
        .size()
        .reset_index(name="actual_cells")
    )

    def quantile_lookup(group_cols):
        grouped = window_counts.groupby(group_cols)["actual_cells"].quantile(0.75)
        return {tuple(int(part) for part in key if key is not None): float(value) for key, value in grouped.items()}

    exact = quantile_lookup(["mes", "dia_semana", "hora"])
    dow_hour = quantile_lookup(["dia_semana", "hora"])
    hour_grouped = window_counts.groupby("hora")["actual_cells"].quantile(0.75)
    hour = {int(key): float(value) for key, value in hour_grouped.items()}
    global_count = float(window_counts["actual_cells"].quantile(0.75)) if not window_counts.empty else 1.0

    return {
        "exact": exact,
        "dow_hour": dow_hour,
        "hour": hour,
        "global": max(global_count, 1.0),
    }


def _expected_hotspot_count(count_lookup, month, day_of_week, hour, top_n, max_hotspots=EVAL_MAX_HOTSPOTS_PER_WINDOW):
    raw_count = (
        count_lookup["exact"].get((int(month), int(day_of_week), int(hour)))
        or count_lookup["dow_hour"].get((int(day_of_week), int(hour)))
        or count_lookup["hour"].get(int(hour))
        or count_lookup["global"]
        or 1
    )
    calibrated = int(np.ceil(float(raw_count)))
    return max(1, min(int(top_n), int(max_hotspots), calibrated))


def _rank_operational_zones(train_df, day_of_week, hour):
    zones = sorted(train_df["zona"].dropna().astype(str).unique())
    if not zones:
        return []

    base_counts = train_df.groupby("zona").size().to_dict()
    hour_counts = train_df.groupby(["zona", "hora"]).size().to_dict()
    day_counts = train_df.groupby(["zona", "dia_semana"]).size().to_dict()

    ranked = []
    for zone in zones:
        score = (
            float(base_counts.get(zone, 0))
            + 3.0 * float(hour_counts.get((zone, int(hour)), 0))
            + 1.0 * float(day_counts.get((zone, int(day_of_week)), 0))
        )
        ranked.append((score, zone))
    ranked.sort(reverse=True)
    return [zone for _, zone in ranked]


def _evaluate_zone_day_hour_model(train_df, test_df, train_year, test_year, top_n=EVAL_ZONE_HOTSPOTS, progress_callback=None):
    if "zona" not in train_df.columns or "zona" not in test_df.columns:
        return {
            "accuracy": 0, "precision": 0, "recall": 0, "f1_score": 0,
            "hit_rate": 0, "pai": 0,
            "train_year": int(train_year), "test_year": int(test_year),
            "windows": 0, "total_incidents": 0, "hits": 0,
            "evaluation_mode": "zone_day_hour",
        }

    train_df = train_df.copy()
    test_df = test_df.copy()
    train_df["zona"] = train_df["zona"].astype(str)
    test_df["zona"] = test_df["zona"].astype(str)

    zone_universe = set(train_df["zona"].dropna().astype(str)) | set(test_df["zona"].dropna().astype(str))
    zone_count = len(zone_universe)
    if zone_count == 0:
        return {
            "accuracy": 0, "precision": 0, "recall": 0, "f1_score": 0,
            "hit_rate": 0, "pai": 0,
            "train_year": int(train_year), "test_year": int(test_year),
            "windows": 0, "total_incidents": 0, "hits": 0,
            "evaluation_mode": "zone_day_hour",
        }

    ranking_cache = {}
    grouped_windows = list(test_df.groupby(["dia_semana", "hora"]))
    total_window_count = len(grouped_windows)
    tp_total = fp_total = fn_total = tn_total = predicted_total = actual_total = 0

    for index, ((day_of_week, hour), window) in enumerate(grouped_windows, start=1):
        actual_ranked = (
            window["zona"]
            .dropna()
            .astype(str)
            .value_counts()
            .head(int(top_n))
        )
        actual_zones = set(actual_ranked.index)
        if not actual_zones:
            continue

        rank_key = (int(day_of_week), int(hour))
        ranked_zones = ranking_cache.get(rank_key)
        if ranked_zones is None:
            ranked_zones = _rank_operational_zones(train_df, int(day_of_week), int(hour))
            ranking_cache[rank_key] = ranked_zones

        predicted_zones = set(ranked_zones[:int(top_n)])
        tp = len(predicted_zones & actual_zones)
        fp = len(predicted_zones - actual_zones)
        fn = len(actual_zones - predicted_zones)
        tn = max(zone_count - tp - fp - fn, 0)

        tp_total += tp
        fp_total += fp
        fn_total += fn
        tn_total += tn
        predicted_total += len(predicted_zones)
        actual_total += len(actual_zones)

        if progress_callback and (index == total_window_count or index % 10 == 0):
            progress_callback({
                "status": "evaluating_zones",
                "completed_windows": int(index),
                "total_windows": int(total_window_count),
                "percent": round((index / max(total_window_count, 1)) * 100, 1),
            })

    precision = tp_total / predicted_total if predicted_total else 0
    recall = tp_total / actual_total if actual_total else 0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0
    total_decisions = tp_total + fp_total + fn_total + tn_total
    accuracy = (tp_total + tn_total) / total_decisions if total_decisions else 0
    area_fraction = predicted_total / max(zone_count * max(total_window_count, 1), 1)
    pai = (recall / area_fraction) if area_fraction else 0

    return {
        "accuracy": round(float(accuracy), 4),
        "precision": round(float(precision), 4),
        "recall": round(float(recall), 4),
        "f1_score": round(float(f1), 4),
        "hit_rate": round(float(recall), 4),
        "pai": round(float(pai), 4),
        "train_year": int(train_year),
        "test_year": int(test_year),
        "windows": int(total_window_count),
        "total_incidents": int(actual_total),
        "hits": int(tp_total),
        "predicted_hits": int(tp_total),
        "predicted_cells": int(predicted_total),
        "top_n": int(top_n),
        "zone_hotspots": int(top_n),
        "evaluation_mode": "zone_day_hour",
    }


def _aggregate_general_scores(model, candidate_grid, months, hours, day_of_week):
    aggregates = {}
    for month in months:
        for hour in hours:
            hourly_scores = _score_candidate_grid_rf(model, candidate_grid, hour, month, day_of_week)
            for cell_key, predicted_incidents, risk_score in hourly_scores:
                bucket = aggregates.setdefault(
                    cell_key,
                    {"predicted_incidents": 0.0, "risk_score": 0.0, "count": 0},
                )
                bucket["predicted_incidents"] += float(predicted_incidents)
                bucket["risk_score"] += float(risk_score)
                bucket["count"] += 1

    scored = []
    for cell_key, bucket in aggregates.items():
        count = max(int(bucket["count"]), 1)
        scored.append((cell_key, bucket["predicted_incidents"] / count, bucket["risk_score"] / count))
    scored.sort(key=lambda item: item[2], reverse=True)
    return scored


# ──────────────────────────────────────────────
# Model persistence
# ──────────────────────────────────────────────

def train_hotspot_model(df, model_path=MODEL_PATH, metadata_path=METADATA_PATH, grid_size=GRID_SIZE_DEGREES):
    """Entrena y guarda un clasificador Random Forest sobre el histórico disponible."""
    model = _train_rf_hotspot_model(df, grid_size=grid_size)

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    with open(model_path, "wb") as model_file:
        pickle.dump(model, model_file)

    prepared_df = _ensure_datetime_fields(df)
    metadata = {
        "trained_at": datetime.utcnow().isoformat() + "Z",
        "grid_size_degrees": grid_size,
        "training_rows": int(model["training_rows"]),
        "source_rows": int(model["source_rows"]),
        "lat_min": float(prepared_df["latitud"].min()),
        "lat_max": float(prepared_df["latitud"].max()),
        "lon_min": float(prepared_df["longitud"].min()),
        "lon_max": float(prepared_df["longitud"].max()),
        "feature_columns": RF_FEATURE_COLUMNS,
    }
    metadata_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
    return metadata


def load_hotspot_model(model_path=MODEL_PATH):
    if not model_path.exists():
        return None
    with open(model_path, "rb") as model_file:
        return pickle.load(model_file)


def load_metadata(metadata_path=METADATA_PATH):
    if not metadata_path.exists():
        return None
    return json.loads(metadata_path.read_text(encoding="utf-8"))


# ──────────────────────────────────────────────
# Candidate grid
# ──────────────────────────────────────────────

def _build_candidate_grid(df, grid_size, neighbor_radius=1):
    observed_cells = (
        _add_grid_columns(df, grid_size=grid_size)[["grid_lat", "grid_lon"]]
        .dropna()
        .drop_duplicates()
        .reset_index(drop=True)
    )
    offsets = range(-neighbor_radius, neighbor_radius + 1)
    candidates = []
    seen = set()
    for _, row in observed_cells.iterrows():
        base_lat = float(row["grid_lat"])
        base_lon = float(row["grid_lon"])
        for d_lat in offsets:
            for d_lon in offsets:
                candidate = (round(base_lat + d_lat * grid_size, 6), round(base_lon + d_lon * grid_size, 6))
                if candidate not in seen:
                    seen.add(candidate)
                    candidates.append(candidate)
    return pd.DataFrame(candidates, columns=["grid_lat", "grid_lon"])


# ──────────────────────────────────────────────
# Representative point / label helpers
# ──────────────────────────────────────────────

def _representative_point(df, cell_key, grid_size, radius=1):
    prepared = _add_grid_columns(df, grid_size=grid_size)
    exact = prepared[(prepared["grid_lat"] == cell_key[0]) & (prepared["grid_lon"] == cell_key[1])]
    if len(exact) > 0:
        return float(exact["latitud"].mean()), float(exact["longitud"].mean())
    nearby = prepared[
        (np.abs(prepared["grid_lat"] - cell_key[0]) / grid_size <= radius) &
        (np.abs(prepared["grid_lon"] - cell_key[1]) / grid_size <= radius)
    ]
    if len(nearby) > 0:
        distances = np.maximum(
            np.abs(nearby["grid_lat"] - cell_key[0]),
            np.abs(nearby["grid_lon"] - cell_key[1]),
        ) / grid_size
        weights = 1.0 / (1.0 + distances)
        return float(np.average(nearby["latitud"], weights=weights)), float(np.average(nearby["longitud"], weights=weights))
    return float(cell_key[0]), float(cell_key[1])


def _representative_label(df, cell_key, grid_size, column="zona", radius=1, fallback="Zona urbana"):
    if column not in df.columns:
        return fallback
    prepared = _add_grid_columns(df, grid_size=grid_size)
    exact = prepared[(prepared["grid_lat"] == cell_key[0]) & (prepared["grid_lon"] == cell_key[1])]
    source = exact if len(exact) > 0 else prepared[
        (np.abs(prepared["grid_lat"] - cell_key[0]) / grid_size <= radius) &
        (np.abs(prepared["grid_lon"] - cell_key[1]) / grid_size <= radius)
    ]
    if len(source) == 0:
        return fallback
    labels = source[column].dropna().astype(str).str.strip()
    labels = labels[labels != ""]
    if labels.empty:
        return fallback
    mode = labels.mode()
    return str(mode.iloc[0]) if not mode.empty else str(labels.iloc[0])


# ──────────────────────────────────────────────
# Training frame selection
# ──────────────────────────────────────────────

def _select_training_frame(df, target_year=None):
    working_df = _ensure_datetime_fields(df)
    if target_year is not None:
        cutoff_year = int(target_year)
        train_df = working_df[working_df["anio"] < cutoff_year].copy()
        if not train_df.empty:
            return working_df, train_df
    return working_df, working_df.copy()


# ──────────────────────────────────────────────
# FIX 9: temporal train/validation split utility
# ──────────────────────────────────────────────

def temporal_train_val_split(df, val_fraction=0.2):
    """
    Split df into train/val sets by time so that val is always the most recent slice.
    val_fraction: proportion of the time range to use for validation (default 20 %).
    """
    working = _ensure_datetime_fields(df).sort_values("fecha")
    cutoff_idx = int(len(working) * (1 - val_fraction))
    return working.iloc[:cutoff_idx].copy(), working.iloc[cutoff_idx:].copy()


# ──────────────────────────────────────────────
# Main prediction entry point
# FIX 2: load pre-trained model from disk; only retrain when needed
# ──────────────────────────────────────────────

def predict_hotspots(
    df,
    hour=None,
    target_date=None,
    target_month=None,
    target_year=None,
    top_n=15,
    model_path=MODEL_PATH,
    metadata_path=METADATA_PATH,
    mode="hourly",
    force_retrain=False,
):
    """
    Predice hotspots usando un Random Forest.

    Por defecto carga el modelo guardado en disco (FIX 2).
    Pasa force_retrain=True para reentrenar desde cero.
    """
    _empty_response = {
        "type": "FeatureCollection",
        "features": [],
        "metadata": {
            "hour": int(hour) if hour is not None else None,
            "mode": mode,
            "top_n": int(top_n),
            "grid_size_degrees": GRID_SIZE_DEGREES,
            "trained_at": None,
            "candidate_cells": 0,
            "target_year": int(target_year) if target_year not in (None, "", "todos") else None,
        },
    }

    if df is None or df.empty:
        return _empty_response

    metadata = load_metadata(metadata_path)
    grid_size = metadata["grid_size_degrees"] if metadata else GRID_SIZE_DEGREES
    working_df, training_df = _select_training_frame(df, target_year=target_year)
    if training_df.empty:
        training_df = working_df.copy()

    # FIX 2: reuse saved model; only train when missing or explicitly asked
    model = None if force_retrain else load_hotspot_model(model_path)
    if model is None:
        model = _train_rf_hotspot_model(training_df, grid_size=grid_size)

    if target_date is not None:
        month, day_of_week = _extract_day_month(training_df, target_date=target_date)
    elif target_month not in (None, "", "todos"):
        month = int(target_month)
        _, day_of_week = _extract_day_month(training_df, target_date=None)
    else:
        month, day_of_week = _extract_day_month(training_df, target_date=None)

    requested_mode = str(mode or "hourly").lower()
    candidate_grid = _build_candidate_grid(training_df, grid_size)
    if candidate_grid.empty:
        return {**_empty_response, "metadata": {**_empty_response["metadata"], "trained_at": metadata.get("trained_at") if metadata else None}}

    if requested_mode == "general" or hour in (None, "", "general"):
        months = (
            [int(target_month)]
            if target_month not in (None, "", "todos")
            else sorted({int(m) for m in training_df["mes"].dropna().astype(int).tolist()}) or [month]
        )
        hours = list(range(24)) if hour in (None, "", "general") else [int(hour)]
        scores = _aggregate_general_scores(model, candidate_grid, months, hours, day_of_week)
    else:
        scores = _score_candidate_grid_rf(model, candidate_grid, int(hour or 0), month, day_of_week)

    top_scores = scores[:top_n]
    max_risk = top_scores[0][2] if top_scores else 1.0
    if max_risk <= 0:
        max_risk = 1.0

    features = []
    for (grid_lat, grid_lon), predicted_incidents, risk_score in top_scores:
        intensity = float(risk_score / max_risk * 100)
        point_lat, point_lon = _representative_point(training_df, (grid_lat, grid_lon), grid_size, radius=1)
        zone_label = _representative_label(training_df, (grid_lat, grid_lon), grid_size, column="zona", radius=1)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(point_lon), float(point_lat)]},
            "properties": {
                "intensidad": float(intensity),
                "riesgo": "Alto" if intensity >= 70 else "Medio" if intensity >= 40 else "Bajo",
                "hora": int(hour) if hour not in (None, "", "general") else "general",
                "predicted_incidents": float(predicted_incidents),
                "risk_score": float(risk_score),
                "grid_lat": float(grid_lat),
                "grid_lon": float(grid_lon),
                "zona": zone_label,
                "mode": requested_mode,
            },
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "hour": int(hour) if hour not in (None, "", "general") else None,
            "mode": requested_mode,
            "top_n": int(top_n),
            "grid_size_degrees": grid_size,
            "trained_at": metadata.get("trained_at") if metadata else None,
            "candidate_cells": int(len(candidate_grid)),
            "target_year": int(target_year) if target_year not in (None, "", "todos") else None,
        },
    }


# ──────────────────────────────────────────────
# Backtest evaluation
# FIX 5: train once, score all windows with the same model
# ──────────────────────────────────────────────

def evaluate_hotspot_model(
    df,
    train_year=2024,
    test_year=2025,
    top_n=15,
    model_path=None,
    metadata_path=None,
    progress_callback=None,
    coverage_radius=EVAL_COVERAGE_RADIUS_CELLS,
    max_eval_hotspots=EVAL_MAX_HOTSPOTS_PER_WINDOW,
    evaluation_mode="zone_day_hour",
):
    """
    Backtest entre dos años del dataset.
    FIX 5: el modelo se entrena una sola vez sobre train_year y se reutiliza
    para evaluar cada ventana del test_year, en lugar de reentrenar por ventana.
    """
    empty = {
        "accuracy": 0, "precision": 0, "recall": 0, "f1_score": 0,
        "hit_rate": 0, "pai": 0,
        "train_year": int(train_year), "test_year": int(test_year),
        "windows": 0, "total_incidents": 0, "hits": 0,
    }

    if df is None or df.empty:
        return empty

    working = _ensure_datetime_fields(df)
    if "anio" in working.columns:
        working["anio"] = pd.to_numeric(working["anio"], errors="coerce").fillna(working["fecha"].dt.year).astype(int)
    else:
        working["anio"] = working["fecha"].dt.year.astype(int)

    train_df = working[working["anio"] <= int(train_year)].copy()
    test_df = working[working["anio"] == int(test_year)].copy()

    if train_df.empty or test_df.empty:
        return {**empty, "total_incidents": int(len(test_df))}

    if str(evaluation_mode or "").lower() == "zone_day_hour":
        return _evaluate_zone_day_hour_model(
            train_df,
            test_df,
            train_year=train_year,
            test_year=test_year,
            top_n=EVAL_ZONE_HOTSPOTS,
            progress_callback=progress_callback,
        )

    grid_size = GRID_SIZE_DEGREES

    # FIX 5: single model trained once on the full training split
    model = _train_rf_hotspot_model(train_df, grid_size=grid_size)
    candidate_grid = _build_candidate_grid(train_df, grid_size)
    candidate_cells = {
        (float(row.grid_lat), float(row.grid_lon))
        for row in candidate_grid.itertuples(index=False)
    }
    candidate_count = len(candidate_cells)
    if not candidate_count:
        return {**empty, "total_incidents": int(len(test_df))}

    grouped_windows = list(test_df.groupby([test_df["fecha"].dt.date, "hora"]))
    total_window_count = len(grouped_windows)
    expected_count_lookup = _build_expected_hotspot_count_lookup(train_df, grid_size)
    score_cache = {}

    total_predicted_hits = total_actual_hits = total_predicted = total_actual = total_universe = total_tn = total_windows = 0

    for (date_value, hour_value), window in grouped_windows:
        target_date = pd.Timestamp(date_value)
        window_grid = _add_grid_columns(window, grid_size=grid_size)
        actual_cells = {
            (float(row.grid_lat), float(row.grid_lon))
            for row in window_grid.itertuples(index=False)
        }

        month = int(target_date.month)
        day_of_week = int(target_date.dayofweek)
        score_key = (month, day_of_week, int(hour_value))
        scores = score_cache.get(score_key)
        if scores is None:
            scores = _score_candidate_grid_rf(model, candidate_grid, int(hour_value), month, day_of_week)
            score_cache[score_key] = scores

        calibrated_top_n = _expected_hotspot_count(
            expected_count_lookup,
            month,
            day_of_week,
            int(hour_value),
            top_n=top_n,
            max_hotspots=max_eval_hotspots,
        )
        predicted_cells = [s[0] for s in scores[:calibrated_top_n]]
        predicted_hits, actual_hits = _coverage_counts(predicted_cells, actual_cells, grid_size, radius=coverage_radius)
        fp = len(predicted_cells) - predicted_hits
        fn = len(actual_cells) - actual_hits
        tn = max(candidate_count - predicted_hits - fp - fn, 0)

        total_predicted_hits += predicted_hits
        total_actual_hits += actual_hits
        total_predicted += len(predicted_cells)
        total_actual += len(actual_cells)
        total_universe += candidate_count
        total_tn += tn
        total_windows += 1

        if progress_callback and (total_windows == total_window_count or total_windows % 10 == 0):
            progress_callback({
                "completed_windows": int(total_windows),
                "total_windows": int(total_window_count),
                "percent": round((total_windows / max(total_window_count, 1)) * 100, 1),
                "cached_score_windows": int(len(score_cache)),
            })

    precision = total_predicted_hits / total_predicted if total_predicted else 0
    recall = total_actual_hits / total_actual if total_actual else 0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0
    area_fraction = total_predicted / total_universe if total_universe else 0
    pai = (recall / area_fraction) if area_fraction else 0
    accuracy = (total_predicted_hits + total_tn) / total_universe if total_universe else 0

    return {
        "accuracy": round(float(accuracy), 4),
        "precision": round(float(precision), 4),
        "recall": round(float(recall), 4),
        "f1_score": round(float(f1), 4),
        "hit_rate": round(float(recall), 4),
        "pai": round(float(pai), 4),
        "train_year": int(train_year),
        "test_year": int(test_year),
        "windows": int(total_windows),
        "total_incidents": int(total_actual),
        "hits": int(total_actual_hits),
        "predicted_hits": int(total_predicted_hits),
        "predicted_cells": int(total_predicted),
        "top_n": int(top_n),
        "max_eval_hotspots": int(max_eval_hotspots),
        "coverage_radius_cells": int(coverage_radius),
        "scored_windows": int(len(score_cache)),
    }


# ──────────────────────────────────────────────
# Auxiliary predictions
# ──────────────────────────────────────────────

def predict_risk_by_hour(df):
    """Devuelve una curva horaria basada en el volumen histórico por hora."""
    if df is None or df.empty:
        return {"horas": list(range(24)), "riesgo_predicho": [0] * 24, "peak_hour": 0}
    counts = df.groupby("hora").size().reindex(range(24), fill_value=0).astype(float)
    smoothed = counts.rolling(window=3, center=True, min_periods=1).mean()
    if smoothed.max() > 0:
        smoothed = smoothed / smoothed.max() * 100
    peak_hour = int(smoothed.idxmax())
    return {"horas": list(range(24)), "riesgo_predicho": smoothed.round(2).tolist(), "peak_hour": peak_hour}


def predict_zones(df, target_hour, target_date=None, target_month=None, target_year=None, mode="hourly"):
    """Devuelve las zonas con mayor riesgo estimado para la combinación temporal dada."""
    if df is None or df.empty:
        return []
    requested_mode = str(mode or "hourly").lower()
    hour_value = None if target_hour in (None, "", "general") else int(target_hour)
    hotspots = predict_hotspots(
        df, hour=hour_value, target_date=target_date,
        target_month=target_month, target_year=target_year,
        top_n=20, mode=requested_mode,
    )
    features = hotspots.get("features", [])
    if not features:
        return []
    aggregated = {}
    for feature in features:
        props = feature.get("properties", {}) if isinstance(feature, dict) else {}
        zone = str(props.get("zona") or "Zona urbana")
        bucket = aggregated.setdefault(zone, {"incidentes": 0.0, "score": 0.0})
        bucket["incidentes"] += float(props.get("predicted_incidents", 0) or 0)
        bucket["score"] += float(props.get("risk_score", 0) or 0)
    total_score = sum(b["score"] for b in aggregated.values())
    rows = [
        {"zona": z, "incidentes": round(float(b["incidentes"]), 2),
         "probabilidad": (float(b["score"]) / total_score) if total_score else 0}
        for z, b in aggregated.items()
    ]
    rows.sort(key=lambda x: x["probabilidad"], reverse=True)
    return rows[:5]
