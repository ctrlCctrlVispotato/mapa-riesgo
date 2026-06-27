"""
Blueprint alternativo con rutas API reutilizables para pruebas o integración modular.
Agrupa las rutas/endpoints de la API REST que usan el mapa, las estadísticas, las predicciones y las zonas de riesgo.
"""

from flask import Blueprint, jsonify, request
from services.analisis import get_heatmap_data, get_risk_summary
from services.modelo import predict_risk_by_hour, predict_zones
from services.limpieza import load_or_download_data
from services.geo import compute_kde_heatmap
import pandas as pd

api_bp = Blueprint('api', __name__)

# Rutas de la API para el mapa, los resúmenes y las predicciones.
# ============================================
# ENDPOINTS PRINCIPALES
# ============================================

@api_bp.route('/test', methods=['GET'])
def test():
    """Endpoint de prueba para verificar que la API funciona"""
    # Sirve para comprobar que el backend responde y que hay datos disponibles.
    df = load_or_download_data()
    return jsonify({
        "status": "API funcionando correctamente",
        "datos_existen": df is not None and len(df) > 0,
        "registros": len(df) if df is not None else 0
    })

@api_bp.route('/heatmap', methods=['GET'])
def heatmap():
    """Devuelve datos para el mapa de calor (todas las zonas)"""
    # Esta ruta entrega los puntos geográficos que luego se dibujan en el frontend.
    df = load_or_download_data()
    if df is None or len(df) == 0:
        return jsonify({"type": "FeatureCollection", "features": []})
    geojson = get_heatmap_data(df)
    return jsonify(geojson)

@api_bp.route('/summary', methods=['GET'])
def summary():
    """Devuelve estadísticas resumidas"""
    # Agrupa los incidentes para alimentar tarjetas, gráficos y resúmenes.
    df = load_or_download_data()
    if df is None or len(df) == 0:
        return jsonify({
            "total_incidentes": 0,
            "pico_hora": 0,
            "zona_mas_riesgosa": "Sin datos"
        })
    return jsonify(get_risk_summary(df))

@api_bp.route('/predict/hour', methods=['GET'])
def predict_hour():
    """Predice riesgo por hora del día"""
    # Devuelve una curva horaria del riesgo estimado para la interfaz.
    df = load_or_download_data()
    if df is None or len(df) == 0:
        # Datos simulados si no hay datos reales
        hourly_risk = [20 + 30 * ((h - 12) ** 2) / 144 for h in range(24)]
        return jsonify({
            "horas": list(range(24)),
            "riesgo_predicho": hourly_risk,
            "peak_hour": 21
        })
    predictions = predict_risk_by_hour(df)
    return jsonify(predictions)

@api_bp.route('/predict/zones', methods=['POST'])
def predict_zones_route():
    """Predice zonas de riesgo para una hora específica (solo texto)"""
    # Retorna un ranking textual simple para acompañar la visualización en mapa.
    df = load_or_download_data()
    if df is None or len(df) == 0:
        return jsonify([])
    hour = request.json.get('hour', 20)
    predictions = predict_zones(df, hour)
    return jsonify(predictions)

@api_bp.route('/predict/zones/geo', methods=['POST'])
def predict_zones_geo():
    """Devuelve SOLO los incidentes de la hora seleccionada"""
    # Compatibilidad con la vista geográfica: muestra puntos en la hora elegida.
    df = load_or_download_data()
    data = request.get_json()
    target_hour = data.get('hour', 20)
    
    # Filtrar incidentes exactos de esa hora
    df_filtered = df[df['hora'] == target_hour]
    
    # Si no hay incidentes exactos, buscar cercanos (±1 hora)
    if len(df_filtered) == 0:
        df_filtered = df[(df['hora'] == target_hour - 1) | (df['hora'] == target_hour + 1)]
    
    if len(df_filtered) == 0:
        return jsonify({"type": "FeatureCollection", "features": []})
    
    # Generar puntos individuales (no heatmap)
    features = []
    for _, row in df_filtered.iterrows():
        # Calcular intensidad (más alta si hay muchos incidentes similares)
        intensidad = 50 + (len(df_filtered) / 100) * 50
        intensidad = min(100, intensidad)
        
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(row['longitud']), float(row['latitud'])]
            },
            "properties": {
                "intensidad": float(intensidad),
                "riesgo": "Alto" if intensidad > 70 else "Medio" if intensidad > 40 else "Bajo",
                "zona": str(row['zona']),
                "hora": int(row['hora'])
            }
        })
    
    return jsonify({"type": "FeatureCollection", "features": features})
