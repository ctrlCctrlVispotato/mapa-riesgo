# Mapa de Riesgo Urbano - Inteligencia Territorial (Panamá)

Sistema de inteligencia territorial que procesa datos de criminalidad del SIEC, aplica análisis de densidad espacial (KDE heatmap) y un modelo de hotspots para estimar zonas y horarios de mayor riesgo.

## Requisitos

- Python 3.8 o superior
- Navegador web

## Instalacion
pip install -r requirements.txt

## Requisitos
Abrir terminal en la carpeta mapa-riesgo-urbano
1. Colocar datos reales de SIEC:
   - Agrega uno o varios CSV o XLSX en `data/raw/`
   - El flujo actual espera columnas como:
     - `ID`
     - `Tipo`
     - `Fecha`
     - `Hora`
     - `Provincia`
     - `Corregimiento`
     - `Latitud`
     - `Longitud`
     - `Arma utilizada`
     - `Locacion`
     - `Anio`
     - `Mes`
     - `Dia de semana`

2. Preparar datos:
python scripts/run_limpieza.py

3. Convertir reportes SIEC a CSV limpio:
python scripts/convert_siec_reports.py --input data/raw --output data/processed/criminalidad_panama_clean.csv --centroids data/zone_centroids.csv

4. Entrenar modelo:
python scripts/train_hotspot_model.py

5. Iniciar servidor:
cd backend
python app.py

3. Abrir navegador en: http://localhost:5000

## Como usar
1. Mover el slider para seleccionar hora
2. Filtrar por tipo de crimen y rango de fechas en la vista principal
3. Click en "Predecir" para ver hotspots de esa hora con el mismo filtro aplicado
4. Click en "Limpiar filtro" para volver al dataset completo
5. En Estadísticas, comparar 2024 vs 2025 por año y por mes, además de revisar las métricas del modelo

## Solucion a Errores encontrados
- Error "No module named flask": 
pip install flask flask-cors pandas numpy
pip install Flask flask-cors pandas numpy scikit-learn

- Error "No hay datos":
python scripts/run_limpieza.py
