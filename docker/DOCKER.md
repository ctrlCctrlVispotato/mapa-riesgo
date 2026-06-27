# Guía para la Generación Automática de Imágenes Docker

## Flujo de trabajo

Este proyecto utiliza **GitHub Actions** para construir automáticamente una imagen Docker cada vez que se publica una nueva versión.

## Formas de activar la compilación

| Método           | Comando / Acción                               | Descripción                                    |
| ---------------- | ---------------------------------------------- | ---------------------------------------------- |
| Publicar un Tag  | `git tag v1.0.0 && git push origin v1.0.0`     | Publica una nueva versión del proyecto.        |
| Crear un Release | Crear un **Release** desde la página de GitHub | Permite generar una nueva versión manualmente. |

## Proceso de construcción

Durante la compilación se realizan los siguientes pasos:

1. Clonar el código fuente del repositorio.
2. Construir la imagen Docker utilizando como base `python:3.9-slim`.
3. Guardar la imagen en formato `.tar`.
4. Subir automáticamente el archivo al apartado **Release Assets** de GitHub.

Archivos generados:

* `mapa-riesgo-v1.0.0.tar` → Imagen correspondiente a una versión específica.
* `mapa-riesgo-latest.tar` → Imagen correspondiente a la versión más reciente.

---

# Descargar la imagen Docker

## Desde GitHub Releases

1. Abrir la página **Releases** del proyecto.
2. Seleccionar la versión que se desea descargar.
3. En la sección **Assets**, descargar el archivo `.tar`.

## Utilizando GitHub CLI

Descargar la versión más reciente:

```bash
gh release download --pattern "*.tar"
```

Descargar una versión específica:

```bash
gh release download v1.0.0 --pattern "*.tar"
```

---

# Utilizar la imagen Docker

## Importar la imagen

```bash
docker load -i mapa-riesgo-v1.0.0.tar
```

## Ejecutar el contenedor

```bash
docker run -d -p 5000:5000 -v "$(pwd)/data:/app/data" mapa-riesgo:latest
```

## Acceder a la aplicación

* Página principal:

  ```
  http://localhost:5000
  ```

* Mapa:

  ```
  http://localhost:5000/maps
  ```

* Estadísticas:

  ```
  http://localhost:5000/statistics
  ```

---

# Montaje de datos (Data Mount)

La imagen Docker **no incluye los archivos de datos**.

Antes de ejecutar el contenedor, es necesario montar las carpetas correspondientes:

```bash
docker run -d \
  -p 5000:5000 \
  -v "$(pwd)/data/raw:/app/data/raw" \
  -v "$(pwd)/data/processed:/app/data/processed" \
  mapa-riesgo:latest
```

También es posible limpiar y preparar los datos directamente dentro del contenedor:

```bash
docker run -it --rm \
  -v "$(pwd)/data:/app/data" \
  mapa-riesgo:latest \
  python scripts/run_limpieza.py
```

---

# Construcción local de la imagen

Si no se desea utilizar GitHub Actions, la imagen Docker puede construirse manualmente:

```bash
docker build -t mapa-riesgo:latest .
docker save mapa-riesgo:latest -o mapa-riesgo.tar
```

---

# Variables de entorno

| Variable      | Valor por defecto | Descripción                                                                     |
| ------------- | ----------------- | ------------------------------------------------------------------------------- |
| `FLASK_HOST`  | `0.0.0.0`         | Dirección donde Flask escuchará las conexiones.                                 |
| `FLASK_DEBUG` | `0`               | Activa o desactiva el modo de depuración. En producción debe permanecer en `0`. |

---

# Solución de problemas

## El puerto 5000 está siendo utilizado

Si el puerto ya está ocupado, ejecutar el contenedor utilizando otro puerto:

```bash
docker run -d -p 5001:5000 mapa-riesgo:latest
```

Luego acceder desde:

```
http://localhost:5001
```

---

## Ver los registros del contenedor

```bash
docker logs <container_id>
```

---

## Acceder al contenedor para depuración

```bash
docker exec -it <container_id> /bin/bash
```
