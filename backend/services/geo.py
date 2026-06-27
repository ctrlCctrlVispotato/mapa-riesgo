"""
Maneja la parte geográfica, como coordenadas, zonas, polígonos y conversiones espaciales.
"""

import numpy as np
import pandas as pd


# Calcula un mapa de densidad simple a partir de coordenadas reales.
def compute_kde_heatmap(df, bandwidth=0.005, grid_size=50):
    """Calcula un heatmap de densidad con un kernel gaussiano simple."""
    # Si hay pocos puntos, no tiene sentido construir una malla de densidad.
    coords = df[["latitud", "longitud"]].dropna().values
    if len(coords) < 10:
        return None

    lat_min, lat_max = 8.92, 9.07
    lon_min, lon_max = -79.58, -79.42

    lat_grid = np.linspace(lat_min, lat_max, grid_size)
    lon_grid = np.linspace(lon_min, lon_max, grid_size)
    xx, yy = np.meshgrid(lon_grid, lat_grid)
    grid_coords = np.c_[yy.ravel(), xx.ravel()]

    diff = grid_coords[:, None, :] - coords[None, :, :]
    dist2 = np.sum(diff**2, axis=2)
    density = np.exp(-dist2 / (2 * bandwidth**2)).sum(axis=1)

    if density.max() > 0:
        density = density / density.max() * 100

    features = []
    for i in range(grid_size):
        for j in range(grid_size):
            val = density[i * grid_size + j]
            if val > 5:
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "Point",
                            "coordinates": [lon_grid[j], lat_grid[i]],
                        },
                        "properties": {
                            "intensidad": float(val),
                            "riesgo": "Alto" if val > 70 else "Medio" if val > 30 else "Bajo",
                        },
                    }
                )

    return {
        "type": "FeatureCollection",
        "features": features,
    }


# Resume los incidentes por zona para obtener un ranking territorial.
def create_risk_grid(df):
    """Crea grid de riesgo por zonas."""
    # Convierte el conteo de incidentes por zona en un ranking relativo fácil de leer.
    zonas_riesgo = df.groupby("zona").size().reset_index(name="incidentes")
    zonas_riesgo["riesgo_relativo"] = zonas_riesgo["incidentes"] / zonas_riesgo["incidentes"].max() * 100
    return zonas_riesgo.to_dict("records")
