"""Limpieza y normalización de datos para análisis, mapas y predicción."""

from __future__ import annotations

import shutil
import tempfile
import unicodedata
from pathlib import Path

import pandas as pd

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent.parent
DATA_DIR = PROJECT_ROOT / "data"
RAW_DATA_DIR = DATA_DIR / "raw"
PROCESSED_DATA_DIR = DATA_DIR / "processed"
PROCESSED_DATA_PATH = PROCESSED_DATA_DIR / "criminalidad_panama_clean.csv"
_PREPARED_DATA_CACHE = {
    "mtime": None,
    "path": None,
    "frame": None,
}

EXPECTED_HEADERS = {
    "id",
    "tipo",
    "fecha",
    "hora",
    "provincia",
    "corregimiento",
    "latitud",
    "longitud",
    "arma utilizada",
    "locacion",
    "anio",
    "mes",
    "dia semana",
}

# Estas listas ayudan a reconocer columnas aunque el nombre cambie entre exportaciones.
DATE_COLUMNS = ["fecha", "date", "fecha_ocurrencia", "fecha_delito", "ocurrencia_fecha", "fecha_hecho"]
TIME_COLUMNS = ["hora", "hour", "hora_ocurrencia", "hora_hecho"]
LAT_COLUMNS = ["latitud", "latitude", "lat"]
LON_COLUMNS = ["longitud", "longitude", "lon", "lng"]
ZONE_COLUMNS = ["corregimiento", "zona", "distrito", "provincia", "sector", "barrio"]
CRIME_COLUMNS = ["tipo", "tipo de delito", "crimen", "delito", "tipo_delito"]
YEAR_COLUMNS = ["anio", "año", "year"]
MONTH_COLUMNS = ["mes", "month"]
DAY_COLUMNS = ["dia_semana", "dia semana", "day_of_week", "weekday", "día semana"]
PROVINCE_COLUMNS = ["provincia", "province"]
WEAPON_COLUMNS = ["arma utilizada", "arma_usada", "weapon", "arma"]
LOCATION_COLUMNS = ["locacion", "locación", "location", "ubicacion", "ubicación"]
ID_COLUMNS = ["id", "codigo", "code", "folio", "registro"]


def _strip_accents(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch))


def _normalize_column_name(value) -> str:
    text = _strip_accents(str(value).strip().lower())
    text = text.replace("_", " ").replace("-", " ")
    text = " ".join(text.split())
    return text


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    # Normaliza nombres para poder reconocer columnas aunque cambie el formato original.
    frame = df.copy()
    frame.columns = [_normalize_column_name(col) for col in frame.columns]
    return frame


def _first_existing_column(df: pd.DataFrame, candidates) -> str | None:
    normalized = {_normalize_column_name(column): column for column in df.columns}
    for candidate in candidates:
        key = _normalize_column_name(candidate)
        if key in normalized:
            return normalized[key]
    return None


def _read_csv_file(path: Path) -> pd.DataFrame:
    return pd.read_csv(path)


def _read_excel_file(path: Path) -> pd.DataFrame:
    # Lee Excel de forma flexible: si no encuentra encabezado exacto, busca una fila probable.
    try:
        raw = pd.read_excel(path, header=None)
    except ImportError as exc:
        raise ImportError(
            "Falta la dependencia 'openpyxl', que pandas usa para leer archivos .xlsx. "
            "Instálala con `pip install -r requirements.txt` o `pip install openpyxl`."
        ) from exc
    except PermissionError:
        temp_path = Path(tempfile.gettempdir()) / path.name
        shutil.copy2(path, temp_path)
        raw = pd.read_excel(temp_path, header=None)

    header_row = None
    for idx, row in raw.iterrows():
        values = {_normalize_column_name(value) for value in row.tolist() if pd.notna(value)}
        overlap = len(values & EXPECTED_HEADERS)
        if overlap >= 5:
            header_row = idx
            break

    if header_row is None:
        header_row = 0

    frame = raw.iloc[header_row + 1 :].copy()
    frame.columns = [
        _normalize_column_name(value) if pd.notna(value) else f"unnamed_{idx}"
        for idx, value in enumerate(raw.iloc[header_row].tolist())
    ]
    frame = frame.dropna(how="all")
    return frame


def _read_tabular_file(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return _read_csv_file(path)
    if suffix in {".xlsx", ".xls"}:
        return _read_excel_file(path)
    raise ValueError(f"Formato no soportado: {path.name}")


def _to_datetime_series(df: pd.DataFrame) -> pd.Series:
    date_col = _first_existing_column(df, DATE_COLUMNS)
    if date_col is None:
        raise ValueError(
            "No se encontró una columna de fecha. Se esperaba algo como 'fecha' o 'date'."
        )
    return pd.to_datetime(df[date_col], errors="coerce")


def _build_year_month_day(df: pd.DataFrame, fecha: pd.Series) -> pd.DataFrame:
    year_col = _first_existing_column(df, YEAR_COLUMNS)
    month_col = _first_existing_column(df, MONTH_COLUMNS)
    day_col = _first_existing_column(df, DAY_COLUMNS)

    if year_col is not None:
        df["anio"] = pd.to_numeric(df[year_col], errors="coerce")
    else:
        df["anio"] = fecha.dt.year

    if month_col is not None:
        df["mes"] = pd.to_numeric(df[month_col], errors="coerce")
    else:
        df["mes"] = fecha.dt.month

    if day_col is not None:
        day_values = df[day_col].astype(str).str.strip().str.lower()
        day_map = {
            "monday": 0,
            "tuesday": 1,
            "wednesday": 2,
            "thursday": 3,
            "friday": 4,
            "saturday": 5,
            "sunday": 6,
            "lunes": 0,
            "martes": 1,
            "miercoles": 2,
            "miércoles": 2,
            "jueves": 3,
            "viernes": 4,
            "sabado": 5,
            "sábado": 5,
            "domingo": 6,
        }
        numeric_days = pd.to_numeric(day_values, errors="coerce")
        mapped_days = day_values.map(day_map)
        df["dia_semana"] = numeric_days.fillna(mapped_days)
    else:
        df["dia_semana"] = fecha.dt.dayofweek

    df["anio"] = df["anio"].fillna(fecha.dt.year).astype("Int64")
    df["mes"] = df["mes"].fillna(fecha.dt.month).astype("Int64")
    df["dia_semana"] = df["dia_semana"].fillna(fecha.dt.dayofweek).astype("Int64")
    return df


def _ensure_required_geo_columns(df: pd.DataFrame) -> pd.DataFrame:
    lat_col = _first_existing_column(df, LAT_COLUMNS)
    lon_col = _first_existing_column(df, LON_COLUMNS)
    if lat_col is None or lon_col is None:
        raise ValueError(
            "El archivo debe incluir coordenadas geográficas. "
            "Se esperaban columnas como 'latitud' y 'longitud'."
        )

    df["latitud"] = pd.to_numeric(df[lat_col], errors="coerce")
    df["longitud"] = pd.to_numeric(df[lon_col], errors="coerce")
    return df


def _ensure_temporal_columns(df: pd.DataFrame) -> pd.DataFrame:
    # Construye fecha, hora, año, mes y día de semana para habilitar los filtros temporales.
    fecha = _to_datetime_series(df)
    df["fecha"] = fecha

    hour_col = _first_existing_column(df, TIME_COLUMNS)
    if hour_col is not None:
        hour_values = df[hour_col].astype(str).str.strip()
        extracted = hour_values.str.extract(r"(?P<hour>\d{1,2})")["hour"]
        df["hora"] = pd.to_numeric(extracted, errors="coerce")
        df["hora"] = df["hora"].fillna(pd.to_numeric(df[hour_col], errors="coerce"))
    else:
        df["hora"] = fecha.dt.hour

    df["hora"] = df["hora"].fillna(fecha.dt.hour).astype("Int64")
    df = _build_year_month_day(df, fecha)
    return df


def _ensure_categorical_columns(df: pd.DataFrame) -> pd.DataFrame:
    # Estandariza columnas textuales para que el backend siempre trabaje con el mismo esquema.
    id_col = _first_existing_column(df, ID_COLUMNS)
    if id_col is not None:
        df["id"] = df[id_col].astype(str).str.strip()
    elif "id" not in df.columns:
        df["id"] = [f"ROW-{idx + 1:05d}" for idx in range(len(df))]

    crime_col = _first_existing_column(df, CRIME_COLUMNS)
    if crime_col is not None:
        df["tipo"] = df[crime_col].astype(str).str.strip()
    elif "tipo" not in df.columns:
        df["tipo"] = "No especificado"

    province_col = _first_existing_column(df, PROVINCE_COLUMNS)
    if province_col is not None:
        df["provincia"] = df[province_col].astype(str).str.strip()
    elif "provincia" not in df.columns:
        df["provincia"] = "Sin provincia"

    zone_col = _first_existing_column(df, ZONE_COLUMNS)
    if zone_col is not None:
        df["corregimiento"] = df[zone_col].astype(str).str.strip()
    elif "corregimiento" not in df.columns:
        df["corregimiento"] = "Sin corregimiento"

    weapon_col = _first_existing_column(df, WEAPON_COLUMNS)
    if weapon_col is not None:
        df["arma_utilizada"] = df[weapon_col].astype(str).str.strip()
    elif "arma_utilizada" not in df.columns:
        df["arma_utilizada"] = "No especificada"

    location_col = _first_existing_column(df, LOCATION_COLUMNS)
    if location_col is not None:
        df["locacion"] = df[location_col].astype(str).str.strip()
    elif "locacion" not in df.columns:
        df["locacion"] = "No especificada"

    df["zona"] = df["corregimiento"]
    df["crimen"] = df["tipo"]
    return df


def load_raw_incidents(raw_source=None):
    """
    Carga uno o varios archivos CSV o Excel crudos.

    raw_source puede ser:
    - None: usa todos los archivos de `data/raw`
    - ruta a un archivo CSV/XLSX
    - ruta a una carpeta con archivos CSV/XLSX
    """
    if raw_source is None:
        raw_source = RAW_DATA_DIR

    source_path = Path(raw_source)
    if not source_path.exists():
        return pd.DataFrame()

    files = []
    if source_path.is_dir():
        files = sorted(
            [
                *source_path.glob("*.csv"),
                *source_path.glob("*.xlsx"),
                *source_path.glob("*.xls"),
            ]
        )
    elif source_path.is_file() and source_path.suffix.lower() in {".csv", ".xlsx", ".xls"}:
        files = [source_path]

    if not files:
        return pd.DataFrame()

    frames = []
    for file_path in files:
        # Procesa cada archivo fuente y conserva su nombre para trazabilidad.
        frame = _read_tabular_file(file_path)
        frame = _normalize_columns(frame)
        frame["source_file"] = file_path.name
        frames.append(frame)

    if not frames:
        return pd.DataFrame()

    return pd.concat(frames, ignore_index=True)


def prepare_dataset(raw_source=None, save=True):
    """
    Normaliza los archivos reales para dejarlos listos para análisis y entrenamiento.
    """
    # Se carga el material crudo, se limpian nombres y se agregan columnas estándar.
    raw_df = load_raw_incidents(raw_source)
    if raw_df.empty:
        raise FileNotFoundError(
            "No se encontraron archivos de datos en data/raw. "
            "Coloca allí los Excel o CSV reales y vuelve a ejecutar el script de limpieza."
        )

    df = _normalize_columns(raw_df)
    df = _ensure_categorical_columns(df)
    df = _ensure_required_geo_columns(df)
    df = _ensure_temporal_columns(df)

    keep_columns = [
        "id",
        "tipo",
        "fecha",
        "hora",
        "provincia",
        "corregimiento",
        "latitud",
        "longitud",
        "arma_utilizada",
        "locacion",
        "anio",
        "mes",
        "dia_semana",
        "zona",
        "crimen",
        "source_file",
    ]
    available_columns = [column for column in keep_columns if column in df.columns]
    df = df[available_columns].copy()

    df = df.dropna(subset=["fecha", "latitud", "longitud", "hora"])
    df["hora"] = pd.to_numeric(df["hora"], errors="coerce").fillna(0).astype(int)
    df["anio"] = pd.to_numeric(df["anio"], errors="coerce").fillna(df["fecha"].dt.year).astype(int)
    df["mes"] = pd.to_numeric(df["mes"], errors="coerce").fillna(df["fecha"].dt.month).astype(int)
    df["dia_semana"] = pd.to_numeric(df["dia_semana"], errors="coerce").fillna(df["fecha"].dt.dayofweek).astype(int)
    df = df.sort_values(["fecha", "hora", "id"]).reset_index(drop=True)

    if save:
        PROCESSED_DATA_DIR.mkdir(parents=True, exist_ok=True)
        df.to_csv(PROCESSED_DATA_PATH, index=False, encoding="utf-8")

    return df


def load_prepared_data():
    if not PROCESSED_DATA_PATH.exists():
        return pd.DataFrame()

    current_mtime = PROCESSED_DATA_PATH.stat().st_mtime
    cached = _PREPARED_DATA_CACHE
    if cached["frame"] is not None and cached["path"] == str(PROCESSED_DATA_PATH) and cached["mtime"] == current_mtime:
        return cached["frame"].copy()

    df = pd.read_csv(PROCESSED_DATA_PATH)
    df["fecha"] = pd.to_datetime(df["fecha"], errors="coerce")
    for column in ["hora", "anio", "mes", "dia_semana"]:
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce").astype("Int64")
    df.attrs["source_signature"] = {
        "path": str(PROCESSED_DATA_PATH),
        "mtime": current_mtime,
        "rows": int(len(df)),
    }
    _PREPARED_DATA_CACHE.update(
        {
            "mtime": current_mtime,
            "path": str(PROCESSED_DATA_PATH),
            "frame": df.copy(),
        }
    )
    return df


def load_or_prepare_data():
    """
    Carga los datos procesados si existen; de lo contrario intenta reconstruirlos desde data/raw.
    """
    # Reutiliza el dataset ya limpio para evitar reprocesar en cada arranque.
    prepared = load_prepared_data()
    if not prepared.empty:
        return prepared

    prepared = prepare_dataset()
    try:
        current_mtime = PROCESSED_DATA_PATH.stat().st_mtime
        prepared.attrs["source_signature"] = {
            "path": str(PROCESSED_DATA_PATH),
            "mtime": current_mtime,
            "rows": int(len(prepared)),
        }
        _PREPARED_DATA_CACHE.update(
            {
                "mtime": current_mtime,
                "path": str(PROCESSED_DATA_PATH),
                "frame": prepared.copy(),
            }
        )
    except OSError:
        pass
    return prepared


def download_real_data(*args, **kwargs):
    raise RuntimeError(
        "La generación sintética fue eliminada. "
        "Usa `prepare_dataset()` con archivos reales dentro de data/raw."
    )
