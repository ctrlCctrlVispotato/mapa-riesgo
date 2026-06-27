"""Entrena y guarda el modelo de hotspots a partir del dataset ya limpio."""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.services.limpieza import load_or_prepare_data
from backend.services.modelo import MODEL_PATH, METADATA_PATH, train_hotspot_model


if __name__ == "__main__":
    # Entrena el modelo ligero usando el dataset ya normalizado.
    # El resultado final se guarda en models/ para que la API lo reutilice.
    print("=" * 60)
    print("ENTRENAMIENTO DEL MODELO DE HOTSPOTS")
    print("=" * 60)

    try:
        df = load_or_prepare_data()
    except Exception as exc:
        print(f"ERROR: No fue posible cargar los datos: {exc}")
        print("   Primero prepara los CSV reales de SIEC en data/raw y ejecuta scripts/run_limpieza.py")
        sys.exit(1)

    if df is None or df.empty:
        print("ERROR: No hay datos suficientes para entrenar.")
        sys.exit(1)

    metadata = train_hotspot_model(df)

    print("\n" + "=" * 60)
    print("Modelo entrenado y guardado")
    print(f"Modelo: {MODEL_PATH}")
    print(f"Metadata: {METADATA_PATH}")
    print(f"Filas de entrenamiento: {metadata['training_rows']}")
    print(f"Filas fuente: {metadata['source_rows']}")
    print(f"Grid: {metadata['grid_size_degrees']} grados")
    print("=" * 60)
