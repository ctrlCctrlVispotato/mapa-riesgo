"""Script de consola para regenerar el CSV limpio desde archivos reales de SIEC.
Ejecuta el proceso de limpieza de datos desde la línea de comandos.
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.services.limpieza import RAW_DATA_DIR, prepare_dataset


if __name__ == "__main__":
    # Script de consola para regenerar el CSV limpio desde archivos reales.
    # Se usa como paso previo antes de entrenar o servir la API.
    print("=" * 60)
    print("PREPARACION DE DATOS SIEC")
    print("=" * 60)
    RAW_DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Carpeta de entrada: {RAW_DATA_DIR}")
    print("Coloca aqui exportaciones reales de SIEC en formato CSV o XLSX.")
    print("   El script normaliza columnas nuevas y guarda el dataset limpio.")

    try:
        df = prepare_dataset()
    except FileNotFoundError as exc:
        print(f"\nADVERTENCIA: {exc}")
        print("\nSiguiente paso:")
        print("1. Descarga o exporta los datos de SIEC en CSV o XLSX")
        print("2. Guárdalos en data/raw/")
        print("3. Ejecuta este script otra vez")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("Datos procesados correctamente")
    print(f"Registros: {len(df)}")
    print(f"Zonas: {df['zona'].nunique()}")
    print(f"Rango: {df['fecha'].min().date()} a {df['fecha'].max().date()}")
    print("=" * 60)
