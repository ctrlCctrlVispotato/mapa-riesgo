"""Convierte reportes SIEC en un CSV limpio compatible con el proyecto."""

import argparse
from pathlib import Path

from backend.services.limpieza import prepare_dataset


def main():
    # Convierte archivos reales de SIEC a un CSV limpio para consumirlo después.
    # Mantiene compatibilidad con flujos donde el dataset se quiere guardar fuera de data/processed.
    parser = argparse.ArgumentParser(description="Convierte reportes reales de SIEC a CSV limpio.")
    parser.add_argument("--input", required=True, help="Archivo o carpeta con datos reales (CSV/XLSX)")
    parser.add_argument("--output", required=True, help="Ruta del CSV limpio de salida")
    parser.add_argument("--centroids", help="Mantenido por compatibilidad. Ya no es necesario.")
    args = parser.parse_args()

    cleaned = prepare_dataset(raw_source=args.input, save=False)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cleaned.to_csv(output_path, index=False, encoding="utf-8")

    print(f"CSV limpio guardado en: {output_path}")
    print(f"Filas: {len(cleaned)}")
    print(f"Zonas: {cleaned['zona'].nunique()}")


if __name__ == "__main__":
    main()
