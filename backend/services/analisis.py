"""Calcula resúmenes, tendencias, distribuciones y métricas estadísticas del dataset."""

try:
    from backend.services.geo import compute_kde_heatmap, create_risk_grid
except ImportError:  # pragma: no cover - fallback for `cd backend && python app.py`
    from services.geo import compute_kde_heatmap, create_risk_grid

# Devuelve el heatmap que se dibuja en la interfaz principal.
def get_heatmap_data(df):
    # Delegamos el cálculo de densidad espacial al módulo geo.
    return compute_kde_heatmap(df)

# Genera el resumen que usan el panel principal y la página de estadísticas.
def get_risk_summary(df):
    # Resume el dataset en estructuras listas para gráficos y tarjetas de KPI.
    total = len(df)
    por_hora = {int(k): int(v) for k, v in df.groupby('hora').size().to_dict().items()}
    por_zona = {str(k): int(v) for k, v in df.groupby('zona').size().to_dict().items()}
    por_crimen = {str(k): int(v) for k, v in df.groupby('crimen').size().to_dict().items()} if 'crimen' in df.columns else {}
    por_anio = {int(k): int(v) for k, v in df.groupby('anio').size().to_dict().items()} if 'anio' in df.columns else {}
    por_mes = {int(k): int(v) for k, v in df.groupby('mes').size().to_dict().items()} if 'mes' in df.columns else {}
    por_mes_anio = {}
    crimen_por_hora = {}

    if 'anio' in df.columns and 'mes' in df.columns:
        meses_por_anio = (
            df.groupby(['anio', 'mes'])
            .size()
            .reset_index(name='incidentes')
        )
        for _, row in meses_por_anio.iterrows():
            year = int(row['anio'])
            month = int(row['mes'])
            por_mes_anio.setdefault(year, {})[month] = int(row['incidentes'])

    if 'hora' in df.columns and 'crimen' in df.columns:
        crimen_hora = (
            df.groupby(['hora', 'crimen'])
            .size()
            .reset_index(name='incidentes')
        )
        for _, row in crimen_hora.iterrows():
            hour = int(row['hora'])
            crime = str(row['crimen'])
            crimen_por_hora.setdefault(hour, {})[crime] = int(row['incidentes'])

    top_zonas = (
        df.groupby('zona')
        .size()
        .sort_values(ascending=False)
        .head(5)
        .reset_index(name='incidentes')
        .to_dict('records')
    )
    if 'fecha' in df.columns:
        df_dates = df.copy()
        df_dates['fecha'] = df_dates['fecha'].astype(str).str[:10]
        por_dia = {str(k): int(v) for k, v in df_dates.groupby('fecha').size().to_dict().items()}
    else:
        por_dia = {}

    if 'anio' in df.columns and not df['anio'].dropna().empty:
        anos = sorted({int(a) for a in df['anio'].dropna().astype(int).tolist()})
    elif 'fecha' in df.columns and not df['fecha'].dropna().empty:
        anos = sorted({int(a) for a in df['fecha'].dt.year.dropna().astype(int).tolist()})
    else:
        anos = []

    if len(anos) == 1:
        alcance = f"Año {anos[0]}"
    elif len(anos) > 1:
        alcance = f"General {anos[0]}-{anos[-1]}"
    else:
        alcance = "General"

    peak_hour = max(por_hora, key=por_hora.get) if por_hora else 0
    
    return {
        'total_incidentes': total,
        'pico_hora': int(peak_hour),
        'zona_mas_riesgosa': max(por_zona, key=por_zona.get),
        'distribucion_hora': por_hora,
        'distribucion_zona': por_zona,
        'distribucion_crimen': por_crimen,
        'distribucion_anio': por_anio,
        'distribucion_mes': por_mes,
        'distribucion_mes_anio': por_mes_anio,
        'top_zonas': top_zonas,
        'distribucion_dia': por_dia,
        'crimen_por_hora': crimen_por_hora,
        'alcance_datos': alcance,
        'anios_disponibles': anos,
    }
