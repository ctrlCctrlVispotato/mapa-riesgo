// Vista de rutas seguras: consulta zonas de riesgo y compara trayectos de Google Maps.
let safeMap = null;
let directionsService = null;
let directionsRenderer = null;
let dangerPolygons = [];
let lastRouteRequest = null;
let currentDangerData = null;
let dangerInfoWindow = null;
let dangerZonesVisible = true;
let originAutocomplete = null;
let destinationAutocomplete = null;
let hourFilterEnabled = false;
const DANGER_ZONE_LIMIT = 120;

// Obtiene la hora local actual para evitar valores fijos en la interfaz.
function getLocalHour() {
    return new Date().getHours();
}

// Devuelve el nombre legible del mes para mostrarlo en la interfaz.
function monthLabel(value) {
    const names = {
        "": "Todo el año",
        "1": "Enero",
        "2": "Febrero",
        "3": "Marzo",
        "4": "Abril",
        "5": "Mayo",
        "6": "Junio",
        "7": "Julio",
        "8": "Agosto",
        "9": "Septiembre",
        "10": "Octubre",
        "11": "Noviembre",
        "12": "Diciembre",
    };
    return names[String(value)] || "Todo el año";
}

// Lee los filtros temporales que controla la vista de rutas seguras.
function getRiskFilters() {
    const hourValue = document.getElementById("riskHour")?.value || String(getLocalHour());
    return {
        year: document.getElementById("riskYear")?.value || "",
        month: document.getElementById("riskMonth")?.value || "",
        hour: hourFilterEnabled ? hourValue : String(getLocalHour()),
        hourFilterEnabled,
    };
}

// Configura las sugerencias de Google Places para que el usuario escriba menos.
function getPlaceAutocompleteOptions() {
    return {
        componentRestrictions: { country: "pa" },
        fields: ["formatted_address", "geometry", "name", "place_id"],
    };
}

// Actualiza la etiqueta visual de la hora elegida en el panel lateral.
// Refleja en pantalla la hora elegida para el análisis de riesgo.
function updateRiskHourLabel() {
    const hour = hourFilterEnabled
        ? (document.getElementById("riskHour")?.value || String(getLocalHour()))
        : String(getLocalHour());
    const label = document.getElementById("riskHourLabel");
    if (label) {
        label.textContent = hourFilterEnabled
            ? `Hora seleccionada: ${String(hour).padStart(2, "0")}:00`
            : `Hora local: ${String(hour).padStart(2, "0")}:00`;
    }
}

// Activa o desactiva el filtro por hora y sincroniza el slider con ese estado.
function toggleHourFilter() {
    hourFilterEnabled = !hourFilterEnabled;
    const slider = document.getElementById("riskHour");
    const button = document.getElementById("hourFilterToggleBtn");
    if (slider) {
        slider.disabled = !hourFilterEnabled;
        if (!hourFilterEnabled) {
            slider.value = String(getLocalHour());
        }
    }
    if (button) {
        button.textContent = "Filtrar por hora";
        button.setAttribute("aria-pressed", hourFilterEnabled ? "true" : "false");
    }
    updateRiskHourLabel();
    updateBanner();
}

// Refresca el banner superior para mostrar el contexto actual del mapa.
// Actualiza el banner superior con el contexto temporal actual.
function updateBanner() {
    const banner = document.getElementById("mapBanner");
    if (!banner) return;
    const filters = getRiskFilters();
    const parts = [`Año ${filters.year || "2025"}`];
    if (filters.month) parts.push(`Mes ${monthLabel(filters.month)}`);
    if (filters.hour !== "" && filters.hour !== undefined) {
        parts.push(hourFilterEnabled
            ? `Hora ${String(filters.hour).padStart(2, "0")}:00`
            : `Hora local ${String(filters.hour).padStart(2, "0")}:00`);
    }
    banner.innerHTML = `Zonas de riesgo activas <strong>${parts.join(" | ")}</strong>`;
}

// Elimina del mapa todas las zonas dibujadas previamente.
// Elimina del mapa todas las zonas dibujadas previamente.
function clearDangerPolygons() {
    dangerPolygons.forEach((polygon) => polygon.setMap(null));
    dangerPolygons = [];
}

// Asigna colores distintos según el nivel de riesgo.
// Asigna colores distintos según el nivel de riesgo.
function polygonFillForRisk(risk) {
    if (risk === "Alto") return { stroke: "#c0392b", fill: "#e74c3c" };
    if (risk === "Medio") return { stroke: "#d68910", fill: "#f39c12" };
    return { stroke: "#52796f", fill: "#84a98c" };
}

// Genera una breve explicación del nivel de riesgo mostrado en el panel.
// Traduce los metadatos de la zona a un texto fácil de leer.
function riskDescription(props) {
    const risk = String(props?.riesgo || "Alto");
    const intensity = Number(props?.intensidad || 0);
    if (risk === "Alto") return `Zona con alta probabilidad de incidentes. Intensidad estimada ${intensity.toFixed(1)}%.`;
    if (risk === "Medio") return `Zona con vigilancia recomendada. Intensidad estimada ${intensity.toFixed(1)}%.`;
    return `Zona con menor concentración estimada de incidentes. Intensidad estimada ${intensity.toFixed(1)}%.`;
}

// Alterna la visibilidad de las zonas de riesgo visibles en el mapa.
// Muestra u oculta las zonas de riesgo ya cargadas.
function toggleDangerZonesVisibility(forceVisible = null) {
    dangerZonesVisible = forceVisible === null ? !dangerZonesVisible : Boolean(forceVisible);
    dangerPolygons.forEach((layer) => {
        layer.setMap(dangerZonesVisible ? safeMap : null);
    });
    const button = document.getElementById("toggleZonesBtn");
    if (button) {
        button.textContent = dangerZonesVisible ? "Ocultar zonas de riesgo" : "Mostrar todas las zonas de riesgo";
    }
}

// Calcula un centro aproximado a partir de los puntos del polígono.
// Calcula un centro aproximado a partir del polígono.
function centerFromPolygon(feature) {
    const coordinates = feature?.geometry?.coordinates?.[0] || [];
    if (!coordinates.length) return null;
    const valid = coordinates.slice(0, Math.max(coordinates.length - 1, 1));
    const total = valid.reduce((acc, [lng, lat]) => {
        acc.lat += Number(lat) || 0;
        acc.lng += Number(lng) || 0;
        return acc;
    }, { lat: 0, lng: 0 });
    const count = valid.length || 1;
    return { lat: total.lat / count, lng: total.lng / count };
}

// Grid cell size in metres at Panama's latitude (~8.98°N).
// 0.01° latitude ≈ 1,112 m; 0.01° longitude ≈ 1,101 m → use 1,112 m as the cell half-diagonal.
const GRID_CELL_METRES = 1112;

// Abre una ventana informativa con los detalles de una zona de riesgo.
// Abre la ventana informativa con detalles de la zona pulsada.
function openDangerInfoWindow(layer, props) {
    if (!safeMap) return;
    if (!dangerInfoWindow) dangerInfoWindow = new google.maps.InfoWindow();

    const center = layer.getCenter ? layer.getCenter() : null;
    if (!center) return;

    const html = `
        <div style="min-width:220px; max-width:280px; font-family:Segoe UI,Tahoma,sans-serif;">
            <div style="font-weight:800; color:#2f3e46; margin-bottom:6px;">${props.zona || "Zona de riesgo"}</div>
            <div style="font-size:0.92rem; color:#354f52; line-height:1.45;">
                <div><strong>Tipo:</strong> ${props.riesgo || "Alto"}</div>
                <div><strong>Intensidad:</strong> ${(Number(props.intensidad || 0)).toFixed(1)}%</div>
                <div><strong>Incidentes estimados:</strong> ${(Number(props.predicted_incidents || 0)).toFixed(2)}</div>
                <div style="margin-top:6px;">${riskDescription(props)}</div>
            </div>
        </div>
    `;

    dangerInfoWindow.setContent(html);
    dangerInfoWindow.setPosition(center);
    dangerInfoWindow.open({ map: safeMap });
}

// Renderiza la lista lateral con el resumen de las zonas más relevantes.
// Resume en tarjetas las zonas más relevantes del resultado.
function renderZoneSummary(features) {
    const container = document.getElementById("zoneSummary");
    if (!container) return;

    if (!Array.isArray(features) || !features.length) {
        container.innerHTML = `
            <div class="zone-card">
                <div class="title">No hay datos suficientes</div>
                <div class="meta">Prueba otro año, mes u hora para cargar zonas de riesgo.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = features.slice(0, 5).map((feature, index) => {
        const props = feature.properties || {};
        const score = Number(props.intensidad || 0).toFixed(1);
        const incidents = Number(props.predicted_incidents || 0).toFixed(2);
        return `
            <div class="zone-card">
                <div class="title">${index === 0 ? "Zona principal" : `Zona ${index + 1}`}: ${props.zona || "Zona urbana"}</div>
                <div class="meta">Riesgo ${props.riesgo || "Alto"} | Intensidad ${score}% | Incidentes estimados ${incidents}</div>
            </div>
        `;
    }).join("");
}

// Dibuja las zonas predichas como círculos interactivos sobre el mapa.
function renderDangerZones(featureCollection) {
    // Convierte el GeoJSON del backend en zonas circulares de riesgo dentro de Google Maps.
    // Each circle is centred on the exact predicted grid cell centre and sized to match
    // the real 0.01° grid cell (≈1,112 m radius), scaled slightly by risk intensity so
    // high-risk zones are visually distinct from low-risk ones.
    clearDangerPolygons();
    currentDangerData = featureCollection;
    const features = (featureCollection?.features || []).filter((feature) => {
        const intensity = Number(feature?.properties?.intensidad || 0);
        return intensity >= 15;
    });
    if (!safeMap) return;

    features.forEach((feature) => {
        const geometry = feature.geometry || {};
        const props = feature.properties || {};
        if (geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length) return;

        const colors = polygonFillForRisk(props.riesgo);
        const center = centerFromPolygon(feature);
        if (!center) return;

        const intensity = Number(props.intensidad || 0);
        // Scale from 0.7× to 1.0× of one grid cell based on intensity.
        // This keeps every circle within the bounds of its real predicted cell.
        const scaleFactor = 0.7 + (intensity / 100) * 0.3;
        const radius = GRID_CELL_METRES * scaleFactor;

        const circle = new google.maps.Circle({
            center,           // exact predicted coordinates — no jitter
            radius,
            map: safeMap,
            strokeColor: colors.stroke,
            strokeOpacity: 0.95,
            strokeWeight: 2.5,
            fillColor: colors.fill,
            fillOpacity: 0.24,
            clickable: true,
        });
        circle.addListener("click", () => openDangerInfoWindow(circle, props));
        circle.addListener("mouseover", () => openDangerInfoWindow(circle, props));
        dangerPolygons.push(circle);
    });

    renderZoneSummary(features);
    toggleDangerZonesVisibility(dangerZonesVisible);
}

// Descarga las zonas de riesgo desde el backend usando el año, mes y hora elegidos.
async function loadDangerZones(includeHour = true, limit = DANGER_ZONE_LIMIT) {
    // Pide al backend las zonas de riesgo según año, mes y hora seleccionados.
    updateBanner();
    updateRiskHourLabel();

    const filters = getRiskFilters();
    const params = new URLSearchParams();
    if (filters.year) params.set("year", filters.year);
    if (filters.month) params.set("month", filters.month);
    const effectiveHour = hourFilterEnabled ? filters.hour : String(getLocalHour());
    if (includeHour && effectiveHour !== "" && effectiveHour !== undefined) params.set("hour", effectiveHour);
    params.set("mode", includeHour && effectiveHour !== "" ? "hourly" : "general");
    params.set("top_n", String(limit));

    const response = await fetch(`/api/danger-zones?${params.toString()}`);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    renderDangerZones(data);
    return data;
}

// Carga todas las zonas generales sin depender de la hora seleccionada.
async function showAllDangerZones() {
    updateRiskHourLabel();
    updateBanner();
    toggleDangerZonesVisibility(true);
    await loadDangerZones();
}

// Toma puntos de la ruta para comprobar si atraviesa zonas de riesgo.
// Genera puntos de muestreo sobre la ruta para comparar con el riesgo.
function routePathSamples(route) {
    const samples = [];
    const path = route?.overview_path || [];
    for (let index = 0; index < path.length; index += 1) {
        const point = path[index];
        samples.push(point);
        if (index < path.length - 1) {
            const nextPoint = path[index + 1];
            samples.push(new google.maps.LatLng(
                (point.lat() + nextPoint.lat()) / 2,
                (point.lng() + nextPoint.lng()) / 2
            ));
        }
    }
    return samples;
}

// Cuenta cuántas zonas de riesgo toca la ruta propuesta.
// Cuenta cuántas zonas de riesgo atraviesa una ruta candidata.
function routeConflictCount(route) {
    if (!dangerPolygons.length) return 0;
    const samples = routePathSamples(route);
    let conflicts = 0;
    dangerPolygons.forEach((circle) => {
        const center = circle.getCenter ? circle.getCenter() : null;
        const radius = circle.getRadius ? circle.getRadius() : 0;
        const hitsZone = center && radius
            ? samples.some((point) => google.maps.geometry.spherical.computeDistanceBetween(point, center) <= radius)
            : false;
        if (hitsZone) conflicts += 1;
    });
    return conflicts;
}

// Muestra mensajes de estado sobre el cálculo de la ruta.
// Escribe mensajes de estado para guiar el cálculo de rutas.
function setRouteStatus(message, type = "info") {
    const status = document.getElementById("routeStatus");
    if (!status) return;
    status.innerHTML = message;
    status.style.borderColor = type === "error" ? "rgba(192,57,43,0.25)" : type === "warning" ? "rgba(214,137,16,0.25)" : "rgba(82,121,111,0.18)";
    status.style.background = type === "error" ? "rgba(231,76,60,0.08)" : type === "warning" ? "rgba(243,156,18,0.09)" : "rgba(82,121,111,0.08)";
}

// Calcula la ruta más segura entre el origen y el destino ingresados.
// Calcula la ruta más segura entre el origen y el destino ingresados.
async function calculateSafeRoute() {
    // Pide rutas a Google Maps y luego elige la alternativa con menos cruces de riesgo.
    const origin = document.getElementById("originInput")?.value.trim();
    const destination = document.getElementById("destinationInput")?.value.trim();
    if (!origin || !destination) {
        setRouteStatus("Escribe un origen y un destino para calcular una ruta segura.", "warning");
        return;
    }

    lastRouteRequest = { origin, destination };
    setRouteStatus("Buscando rutas y comparándolas con las zonas de riesgo...", "info");

    try {
        const result = await directionsService.route({
            origin,
            destination,
            travelMode: google.maps.TravelMode.DRIVING,
            provideRouteAlternatives: true,
            optimizeWaypoints: false,
            unitSystem: google.maps.UnitSystem.METRIC,
        });

        const routes = result?.routes || [];
        if (!routes.length) {
            setRouteStatus("Google Maps no devolvió rutas para esta combinación.", "warning");
            return;
        }

        const ranked = routes
            .map((route, index) => ({ route, index, conflicts: routeConflictCount(route) }))
            .sort((a, b) => a.conflicts - b.conflicts);

        const selected = ranked[0];
        directionsRenderer.setDirections(result);
        directionsRenderer.setRouteIndex(selected.index);

        if (selected.conflicts === 0) {
            setRouteStatus(`Ruta segura encontrada. Se evitó el paso por las zonas de riesgo visibles.`, "info");
        } else {
            setRouteStatus(`No se encontró una ruta totalmente limpia. Se mostró la alternativa con menos cruces de riesgo.`, "warning");
        }
    } catch (error) {
        console.error(error);
        setRouteStatus("No fue posible calcular la ruta. Verifica el origen y el destino.", "error");
    }
}

// Limpia la ruta mostrada para empezar una nueva búsqueda.
// Limpia la ruta mostrada para empezar una nueva búsqueda.
function clearRoute() {
    if (directionsRenderer) {
        directionsRenderer.set("directions", null);
    }
    lastRouteRequest = null;
    setRouteStatus("Ruta limpiada. Puedes calcular una nueva combinación.", "info");
}

// Inicializa el mapa, los controles y los eventos de la vista segura.
// Inicializa el mapa, los controles y los eventos de la vista segura.
async function initMap() {
    // Inicializa el mapa, los buscadores y los controles de la vista segura.
    safeMap = new google.maps.Map(document.getElementById("map"), {
        center: { lat: 8.983, lng: -79.52 },
        zoom: 11,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        styles: [
            { elementType: "geometry", stylers: [{ color: "#eef3ef" }] },
            { elementType: "labels.text.fill", stylers: [{ color: "#354f52" }] },
            { elementType: "labels.text.stroke", stylers: [{ color: "#f8fbf9" }] },
            { featureType: "poi", elementType: "geometry", stylers: [{ color: "#dce7df" }] },
            { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
            { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#cfdad4" }] },
            { featureType: "water", elementType: "geometry", stylers: [{ color: "#b9d4df" }] },
        ],
    });

    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
        map: safeMap,
        suppressMarkers: false,
        polylineOptions: {
            strokeColor: "#2f3e46",
            strokeOpacity: 0.95,
            strokeWeight: 6,
        },
    });

    const originInput = document.getElementById("originInput");
    const destinationInput = document.getElementById("destinationInput");
    if (originInput && google.maps.places) {
        originAutocomplete = new google.maps.places.Autocomplete(originInput, getPlaceAutocompleteOptions());
        originAutocomplete.addListener("place_changed", () => {
            const place = originAutocomplete.getPlace();
            if (place?.formatted_address) originInput.value = place.formatted_address;
            else if (place?.name) originInput.value = place.name;
        });
    }
    if (destinationInput && google.maps.places) {
        destinationAutocomplete = new google.maps.places.Autocomplete(destinationInput, getPlaceAutocompleteOptions());
        destinationAutocomplete.addListener("place_changed", () => {
            const place = destinationAutocomplete.getPlace();
            if (place?.formatted_address) destinationInput.value = place.formatted_address;
            else if (place?.name) destinationInput.value = place.name;
        });
    }

    document.getElementById("refreshZonesBtn")?.addEventListener("click", loadDangerZones);
    document.getElementById("showAllZonesBtn")?.addEventListener("click", showAllDangerZones);
    document.getElementById("toggleZonesBtn")?.addEventListener("click", () => toggleDangerZonesVisibility());
    document.getElementById("hourFilterToggleBtn")?.addEventListener("click", toggleHourFilter);
    document.getElementById("routeBtn")?.addEventListener("click", calculateSafeRoute);
    document.getElementById("clearBtn")?.addEventListener("click", clearRoute);

    const riskHour = document.getElementById("riskHour");
    if (riskHour) {
        riskHour.value = String(getLocalHour());
        riskHour.disabled = true;
        riskHour.addEventListener("input", updateRiskHourLabel);
        riskHour.addEventListener("change", async () => {
            updateBanner();
            await loadDangerZones();
            if (lastRouteRequest) {
                await calculateSafeRoute();
            }
        });
    }

    const hourToggle = document.getElementById("hourFilterToggleBtn");
    if (hourToggle) {
        hourToggle.setAttribute("aria-pressed", "false");
        hourToggle.textContent = "Filtrar por hora";
    }

    const riskYear = document.getElementById("riskYear");
    const riskMonth = document.getElementById("riskMonth");
    if (riskYear) {
        riskYear.addEventListener("change", async () => {
            updateBanner();
            await loadDangerZones();
            if (lastRouteRequest) {
                await calculateSafeRoute();
            }
        });
    }
    if (riskMonth) {
        riskMonth.addEventListener("change", async () => {
            updateBanner();
            await loadDangerZones();
            if (lastRouteRequest) {
                await calculateSafeRoute();
            }
        });
    }

    updateRiskHourLabel();
    updateBanner();
    toggleDangerZonesVisibility(true);
    await loadDangerZones();
}

window.initMap = initMap;
