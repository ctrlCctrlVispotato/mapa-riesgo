"""Servidor principal Flask: sirve el frontend y expone la API REST del proyecto.
"""

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from datetime import datetime
import pandas as pd
import os

try:
    from backend.services.analisis import get_risk_summary
    from backend.services.limpieza import load_or_prepare_data
    from backend.services.modelo import evaluate_hotspot_model, predict_hotspots, predict_risk_by_hour, predict_zones, train_hotspot_model
except ImportError:  # pragma: no cover - fallback for `cd backend && python app.py`
    from services.analisis import get_risk_summary
    from services.limpieza import load_or_prepare_data
    from services.modelo import evaluate_hotspot_model, predict_hotspots, predict_risk_by_hour, predict_zones, train_hotspot_model

app = Flask(__name__, static_folder="../frontend", static_url_path="")
CORS(app)

_SUMMARY_CACHE = {}
_REPORT_CACHE = {}
_EVALUATION_CACHE = {}
_DATASET_CACHE = {}

# Este servidor expone la interfaz web y todos los endpoints de análisis y predicción.

def load_data():
    # Carga el dataset limpio desde disco o lo reconstruye si aún no existe.
    try:
        df = load_or_prepare_data()
        if df is None or df.empty:
            print("ERROR: No hay datos procesados disponibles")
            return None
        source_signature = getattr(df, "attrs", {}).get("source_signature")
        if source_signature:
            _DATASET_CACHE["signature"] = source_signature
        print(f"Datos cargados: {len(df)} registros")
        return df
    except Exception as e:
        print(f"ERROR cargando datos: {e}")
        return None


def _parse_request_filters():
    # Unifica filtros que pueden llegar por query string o por JSON.
    payload = request.get_json(silent=True) or {}
    combined = {
        "crime": payload.get("crime") or request.args.get("crime"),
        "start_date": payload.get("start_date") or request.args.get("start_date"),
        "end_date": payload.get("end_date") or request.args.get("end_date"),
        "year": payload.get("year") or request.args.get("year"),
        "month": payload.get("month") or request.args.get("month"),
        "hour": payload.get("hour") or request.args.get("hour"),
    }
    return combined


def _apply_filters(df, crime=None, start_date=None, end_date=None, year=None, month=None, hour=None):
    # Aplica el mismo filtro lógico en todas las rutas para evitar inconsistencias.
    if df is None or len(df) == 0:
        return df

    filtered = df.copy()

    if crime and crime != "todos":
        filtered = filtered[filtered["crimen"].astype(str).str.lower() == str(crime).strip().lower()]

    if year not in (None, "", "todos"):
        try:
            target_year = int(year)
            if "anio" in filtered.columns:
                year_values = pd.to_numeric(filtered["anio"], errors="coerce")
                filtered = filtered[year_values == target_year]
            else:
                filtered = filtered[filtered["fecha"].dt.year == target_year]
        except ValueError:
            pass

    if month not in (None, "", "todos"):
        try:
            target_month = int(month)
            if "mes" in filtered.columns:
                month_values = pd.to_numeric(filtered["mes"], errors="coerce")
                filtered = filtered[month_values == target_month]
            else:
                filtered = filtered[filtered["fecha"].dt.month == target_month]
        except ValueError:
            pass

    if hour not in (None, "", "todos"):
        try:
            target_hour = int(hour)
            filtered = filtered[pd.to_numeric(filtered["hora"], errors="coerce") == target_hour]
        except ValueError:
            pass

    if start_date:
        start_ts = pd.to_datetime(start_date, errors="coerce")
        if pd.notna(start_ts):
            filtered = filtered[filtered["fecha"] >= start_ts]

    if end_date:
        end_ts = pd.to_datetime(end_date, errors="coerce")
        if pd.notna(end_ts):
            filtered = filtered[filtered["fecha"] <= end_ts]

    return filtered


def _dataset_signature(df):
    if df is None:
        return None
    signature = getattr(df, "attrs", {}).get("source_signature") or _DATASET_CACHE.get("signature")
    if signature:
        return tuple(sorted(signature.items()))
    return None


def _cache_key(prefix, df, filters=None, extra=None):
    signature = _dataset_signature(df)
    filters_key = tuple(sorted((filters or {}).items()))
    extra_key = tuple(sorted((extra or {}).items())) if isinstance(extra, dict) else extra
    return (prefix, signature, filters_key, extra_key)


@app.route("/")
def index():
    return send_from_directory("../frontend", "index.html")


@app.route("/statistics")
def statistics_page():
    return send_from_directory("../frontend", "stats.html")


@app.route("/maps")
def maps_page():
    # Sirve la vista independiente de Google Maps para rutas seguras.
    return send_from_directory("../frontend", "maps.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory("../frontend", path)


@app.route("/api/test")
def test():
    # Endpoint mínimo para verificar que la API y la carga de datos están funcionando.
    df = load_data()
    return jsonify(
        {
            "status": "API funcionando correctamente",
            "datos_existen": df is not None and len(df) > 0,
            "registros": len(df) if df is not None else 0,
        }
    )


@app.route("/api/summary")
def summary():
    # Devuelve el resumen general que alimenta el panel principal y estadísticas.
    df = load_data()
    if df is None or len(df) == 0:
        return jsonify({"total_incidentes": 0, "pico_hora": 0, "zona_mas_riesgosa": "Sin datos"})
    filters = _parse_request_filters()
    cache_key = _cache_key("summary", df, filters)
    cached = _SUMMARY_CACHE.get(cache_key)
    if cached is not None:
        cached_response = dict(cached)
        cached_response["cache_info"] = {
            "status": "cached",
            "source_rows": int(len(df)),
        }
        return jsonify(cached_response)
    df = _apply_filters(df, **filters)
    if df is None or len(df) == 0:
        payload = {"total_incidentes": 0, "pico_hora": 0, "zona_mas_riesgosa": "Sin datos"}
        return jsonify(payload)
    payload = get_risk_summary(df)
    source_signature = _dataset_signature(df)
    if source_signature:
        payload["cache_info"] = {
            "status": "fresh",
            "source_rows": int(len(df)),
        }
    _SUMMARY_CACHE[cache_key] = payload
    return jsonify(payload)


# Columns actually consumed by stats.js (KPIs, zone filter, CSV export, charts).
# Keeping this list tight avoids serialising large unused columns on every page load.
_REPORT_COLUMNS = [
    "id", "tipo", "fecha", "hora", "provincia", "corregimiento",
    "latitud", "longitud", "arma_utilizada", "locacion",
    "anio", "mes", "dia_semana", "zona", "crimen", "source_file",
]

@app.route("/api/report/data")
def report_data():
    """
    Returns a slim subset of the cleaned dataset for the statistics page.

    Only the columns the frontend actually reads are included so the JSON
    payload stays small even when the CSV has 12 k+ rows.
    """
    df = load_data()
    if df is None or len(df) == 0:
        return jsonify({"rows": []})

    filters = _parse_request_filters()
    cache_key = _cache_key("report", df, filters)
    cached = _REPORT_CACHE.get(cache_key)
    if cached is not None:
        cached_response = dict(cached)
        cached_response["cache_info"] = {"status": "cached", "rows": len(cached.get("rows", []))}
        return jsonify(cached_response)

    df = _apply_filters(df, **filters)

    # Keep only the columns the frontend needs
    keep = [c for c in _REPORT_COLUMNS if c in df.columns]
    rows = df[keep].copy()
    rows["fecha"] = rows["fecha"].astype(str)
    # Sort in Python after column selection so we don't drag unused columns through sort
    rows = rows.sort_values(["zona", "fecha", "hora"], ascending=[True, False, True])
    payload = rows.to_dict(orient="records")
    response = {"rows": payload, "cache_info": {"status": "fresh", "rows": len(payload)}}
    _REPORT_CACHE[cache_key] = response
    return jsonify(response)


@app.route("/api/heatmap")
def heatmap():
    """
    Devuelve los incidentes reales como puntos para evitar el efecto de cuadrícula.
    """
    df = load_data()
    if df is None or len(df) == 0:
        return jsonify({"type": "FeatureCollection", "features": []})

    filters = _parse_request_filters()
    df = _apply_filters(df, **filters)

    features = []
    hour_counts = df.groupby("hora").size()
    max_hour_count = float(hour_counts.max()) if len(hour_counts) else 1.0

    for _, row in df.iterrows():
        lat = row.get("latitud")
        lon = row.get("longitud")
        if pd.isna(lat) or pd.isna(lon):
            continue

        hour = int(row["hora"])
        hour_factor = hour_counts.get(hour, 0) / max_hour_count if max_hour_count else 0
        intensity = 35 + hour_factor * 65
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [float(lon), float(lat)],
                },
                "properties": {
                    "intensidad": float(intensity),
                    "riesgo": "Alto" if intensity > 70 else "Medio" if intensity > 40 else "Bajo",
                    "zona": str(row["zona"]),
                    "hora": hour,
                    "crimen": str(row.get("crimen", "No especificado")),
                },
            }
        )

    if not features:
        return jsonify({"type": "FeatureCollection", "features": []})

    return jsonify({"type": "FeatureCollection", "features": features})


@app.route("/api/heatmap/filter", methods=["POST"])
def heatmap_filter():
    """
    Conserva compatibilidad con el frontend: muestra los incidentes reales de una hora concreta.
    """
    df = load_data()
    if df is None or len(df) == 0:
        return jsonify({"type": "FeatureCollection", "features": []})

    data = request.get_json(silent=True) or {}
    target_hour = int(data.get("hour", 20))
    df_filtered = _apply_filters(
        df[df["hora"] == target_hour],
        crime=data.get("crime"),
        start_date=data.get("start_date"),
        end_date=data.get("end_date"),
        year=data.get("year"),
    )

    if len(df_filtered) == 0:
        return jsonify({"type": "FeatureCollection", "features": []})

    features = []
    for _, row in df_filtered.iterrows():
        intensity = 50 + min(50, (len(df_filtered) / max(len(df), 1)) * 100)
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [float(row["longitud"]), float(row["latitud"])],
                },
                "properties": {
                    "intensidad": float(intensity),
                    "riesgo": "Alto" if intensity > 70 else "Medio" if intensity > 40 else "Bajo",
                    "zona": str(row["zona"]),
                    "hora": int(row["hora"]),
                    "crimen": str(row.get("crimen", "No especificado")),
                },
            }
        )

    return jsonify({"type": "FeatureCollection", "features": features})


@app.route("/api/predict/hour")
def predict_hour():
    # Calcula la curva de riesgo por hora a partir del comportamiento histórico.
    df = load_data()
    if df is None or len(df) == 0:
        return jsonify({"horas": list(range(24)), "riesgo_predicho": [0] * 24, "peak_hour": 0})

    filters = _parse_request_filters()
    df = _apply_filters(df, **filters)
    return jsonify(predict_risk_by_hour(df))


@app.route("/api/predict/zones", methods=["POST"])
def predict_zones_route():
    # Devuelve el ranking textual de zonas con mayor riesgo estimado.
    df = load_data()
    if df is None or len(df) == 0:
        return jsonify([])

    data = request.get_json(silent=True) or {}
    hour_value = data.get("hour", 20)
    hour = int(hour_value) if hour_value not in (None, "", "general") else 20
    mode = data.get("mode", "hourly")
    target_date = data.get("date")
    target_month = data.get("month")
    if target_month in (None, "", "todos") and target_date:
        parsed_date = pd.to_datetime(target_date, errors="coerce")
        if pd.notna(parsed_date):
            target_month = int(parsed_date.month)
    filtered_df = _apply_filters(
        df,
        crime=data.get("crime"),
        start_date=data.get("start_date"),
        end_date=data.get("end_date"),
        month=target_month,
        hour=data.get("hour") if mode != "general" else None,
    )
    return jsonify(
        predict_zones(
            filtered_df,
            hour,
            target_date=target_date,
            target_month=target_month,
            target_year=data.get("year"),
            mode=mode,
        )
    )


@app.route("/api/predict/hotspots", methods=["POST"])
def predict_hotspots_route():
    # Devuelve los hotspots geográficos en formato GeoJSON para dibujarlos en el mapa.
    df = load_data()
    if df is None or len(df) == 0:
        return jsonify({"type": "FeatureCollection", "features": [], "metadata": {"hour": 0, "top_n": 0}})

    data = request.get_json(silent=True) or {}
    hour_value = data.get("hour", 20)
    hour = int(hour_value) if hour_value not in (None, "", "general") else None
    target_date = data.get("date")
    target_month = data.get("month")
    if target_month in (None, "", "todos") and target_date:
        parsed_date = pd.to_datetime(target_date, errors="coerce")
        if pd.notna(parsed_date):
            target_month = int(parsed_date.month)
    top_n = int(data.get("top_n", 15))
    mode = data.get("mode", "hourly")
    filtered_df = _apply_filters(
        df,
        crime=data.get("crime"),
        start_date=data.get("start_date"),
        end_date=data.get("end_date"),
        month=target_month,
        hour=hour if mode != "general" else None,
    )
    hotspots = predict_hotspots(
        filtered_df,
        hour=hour,
        target_date=target_date,
        target_month=target_month,
        target_year=data.get("year"),
        top_n=top_n,
        mode=mode,
    )
    return jsonify(hotspots)


@app.route("/api/danger-zones")
def danger_zones():
    """
    Devuelve zonas de riesgo como polígonos GeoJSON para superponerlas sobre Google Maps.
    """
    df = load_data()
    if df is None or len(df) == 0:
        return jsonify({"type": "FeatureCollection", "features": [], "metadata": {"hour": None, "mode": "hourly", "top_n": 15}})

    filters = _parse_request_filters()
    filters["hour"] = request.args.get("hour", filters.get("hour"))
    filters["month"] = request.args.get("month", filters.get("month"))
    filters["year"] = request.args.get("year", filters.get("year"))
    filters["crime"] = request.args.get("crime", filters.get("crime"))
    filters["start_date"] = request.args.get("start_date", filters.get("start_date"))
    filters["end_date"] = request.args.get("end_date", filters.get("end_date"))

    target_date = request.args.get("date")
    target_month = filters.get("month")
    if target_month in (None, "", "todos") and target_date:
        parsed_date = pd.to_datetime(target_date, errors="coerce")
        if pd.notna(parsed_date):
            target_month = int(parsed_date.month)

    hour_value = request.args.get("hour")
    if hour_value in (None, "", "general"):
        hour = None
    else:
        try:
            hour = int(hour_value)
        except ValueError:
            hour = None

    mode = request.args.get("mode", "hourly")
    top_n = int(request.args.get("top_n", 15))
    filtered_df = _apply_filters(
        df,
        crime=filters.get("crime"),
        start_date=filters.get("start_date"),
        end_date=filters.get("end_date"),
        month=target_month,
        hour=hour if mode != "general" else None,
    )
    hotspots = predict_hotspots(
        filtered_df,
        hour=hour,
        target_date=target_date,
        target_month=target_month,
        target_year=filters.get("year"),
        top_n=top_n,
        mode=mode,
    )
    grid_size = float(hotspots.get("metadata", {}).get("grid_size_degrees", 0.01))
    half = grid_size / 2
    # Convertimos los hotspots predichos en polígonos simples para visualizarlos en el mapa.
    features = []

    for feature in hotspots.get("features", []):
        if not isinstance(feature, dict):
            continue
        geometry = feature.get("geometry", {})
        coordinates = geometry.get("coordinates", [])
        if len(coordinates) < 2:
            continue
        lon = float(coordinates[0])
        lat = float(coordinates[1])
        props = feature.get("properties", {}) if isinstance(feature.get("properties", {}), dict) else {}
        intensity = float(props.get("intensidad", 0) or 0)
        if intensity < 15:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[
                        [lon - half, lat - half],
                        [lon + half, lat - half],
                        [lon + half, lat + half],
                        [lon - half, lat + half],
                        [lon - half, lat - half],
                    ]],
                },
                "properties": {
                    "zona": props.get("zona", "Zona urbana"),
                    "intensidad": intensity,
                    "riesgo": props.get("riesgo", "Alto"),
                    "hora": props.get("hora", hour if hour is not None else "general"),
                    "predicted_incidents": float(props.get("predicted_incidents", 0) or 0),
                    "risk_score": float(props.get("risk_score", 0) or 0),
                },
            }
        )

    return jsonify(
        {
            "type": "FeatureCollection",
            "features": features,
            "metadata": {
                "hour": hour,
                "mode": mode,
                "top_n": top_n,
                "grid_size_degrees": grid_size,
                "zones": len(features),
            },
        }
    )


import threading as _threading

# Tracks in-progress background evaluations so we never run duplicates.
_EVALUATION_RUNNING = set()
_EVALUATION_LOCK = _threading.Lock()
_EVALUATION_PROGRESS = {}

_EVALUATION_PENDING_RESPONSE = {
    "status": "pending",
    "accuracy": None,
    "precision": None,
    "recall": None,
    "f1_score": None,
    "hit_rate": None,
    "pai": None,
    "train_year": None,
    "test_year": None,
    "windows": 0,
    "total_incidents": 0,
    "hits": 0,
    "cache_info": {"status": "computing"},
}


def _run_evaluation_background(filtered_df, train_year, test_year, cache_key):
    """Runs the backtest in a background thread and stores the result in the cache."""
    def update_progress(progress):
        with _EVALUATION_LOCK:
            _EVALUATION_PROGRESS[cache_key] = {
                **progress,
                "status": "computing",
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }

    try:
        with _EVALUATION_LOCK:
            _EVALUATION_PROGRESS[cache_key] = {
                "status": "training",
                "completed_windows": 0,
                "total_windows": 0,
                "percent": 0,
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }
        payload = evaluate_hotspot_model(
            filtered_df,
            train_year=train_year,
            test_year=test_year,
            progress_callback=update_progress,
        )
        payload["status"] = "ready"
        payload["cache_info"] = {
            "status": "fresh",
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "train_year": train_year,
            "test_year": test_year,
        }
        _EVALUATION_CACHE[cache_key] = payload
    except Exception as exc:
        _EVALUATION_CACHE[cache_key] = {**_EVALUATION_PENDING_RESPONSE, "status": "error", "error": str(exc)}
    finally:
        with _EVALUATION_LOCK:
            _EVALUATION_RUNNING.discard(cache_key)
            _EVALUATION_PROGRESS.pop(cache_key, None)


@app.route("/api/model/evaluation")
def model_evaluation():
    """
    Returns backtest metrics for the statistics page.

    Because the backtest can take minutes, this endpoint returns immediately:
    - If the result is already cached → returns it at once.
    - If it is being computed    → returns {"status": "pending"} so the
      frontend can poll and show a spinner instead of hanging forever.
    - If neither                 → starts the backtest in a background thread
      and immediately returns {"status": "pending"}.

    The frontend should poll this endpoint every ~5 s until status == "ready".
    """
    df = load_data()
    _empty = {
        "status": "ready",
        "accuracy": 0, "precision": 0, "recall": 0, "f1_score": 0,
        "hit_rate": 0, "pai": 0,
        "train_year": 2024, "test_year": 2025,
        "windows": 0, "total_incidents": 0, "hits": 0,
    }
    if df is None or len(df) == 0:
        return jsonify(_empty)

    filters = _parse_request_filters()
    filtered_df = _apply_filters(df, **filters)
    cache_key = _cache_key("evaluation", filtered_df, filters, extra={"type": "evaluation", "version": "zone_day_hour_v3"})

    # Return cached result immediately if available
    cached = _EVALUATION_CACHE.get(cache_key)
    if cached is not None:
        resp = dict(cached)
        resp.setdefault("cache_info", {})["status"] = "cached"
        return jsonify(resp)

    # Determine train/test years
    years = []
    if filtered_df is not None and len(filtered_df) > 0 and "anio" in filtered_df.columns:
        years = sorted({int(y) for y in pd.to_numeric(filtered_df["anio"], errors="coerce").dropna().astype(int)})
    train_year = years[-2] if len(years) >= 2 else (years[0] if years else 2024)
    test_year = years[-1] if years else 2025

    # Start background thread if not already running
    with _EVALUATION_LOCK:
        if cache_key not in _EVALUATION_RUNNING:
            _EVALUATION_RUNNING.add(cache_key)
            t = _threading.Thread(
                target=_run_evaluation_background,
                args=(filtered_df.copy(), train_year, test_year, cache_key),
                daemon=True,
            )
            t.start()

    pending = dict(_EVALUATION_PENDING_RESPONSE)
    pending["train_year"] = train_year
    pending["test_year"] = test_year
    with _EVALUATION_LOCK:
        pending["progress"] = dict(_EVALUATION_PROGRESS.get(cache_key, {}))
    return jsonify(pending)


if __name__ == "__main__":
    print("\n" + "=" * 50)
    print("SERVIDOR MAPA DE RIESGO URBANO")
    print("=" * 50)
    df = load_data()
    if df is not None:
        print(f"{len(df)} incidentes cargados")
        print(f"{df['zona'].nunique()} zonas")
        print("\nDistribucion por hora:")
        horas_con_datos = df.groupby("hora").size()
        for hora, count in horas_con_datos.items():
            if count > 0:
                print(f"   {hora}:00 -> {count} incidentes")
    else:
        print("ADVERTENCIA: No hay datos procesados - Coloca archivos CSV reales de SIEC en data/raw y ejecuta scripts/run_limpieza.py")
    if df is not None and len(df) > 0:
        try:
            metadata = train_hotspot_model(df)
            print(f"Modelo Random Forest actualizado: {metadata['training_rows']} filas de entrenamiento")
        except Exception as exc:
            print(f"ADVERTENCIA: No fue posible entrenar el modelo automáticamente: {exc}")
    print("=" * 50)
    print("http://localhost:5000")
    print("http://localhost:5000/maps")
    print("=" * 50 + "\n")
    
    host = os.environ.get("FLASK_HOST", "0.0.0.0")
    app.run(debug=True, host=host, port=5000)
