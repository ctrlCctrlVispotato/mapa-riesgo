// Lógica principal del dashboard: controla la pagina principal, mapa, filtros, predicciones y paneles laterales.
let map;
let baseLayer = null;
let currentLayer = null;
let riskChart = null;
let crimeChart = null;
let currentHour = 20;
let currentYear = 2024;
let currentViewMonth = "";
let currentViewHour = "";
let currentViewMode = "real";
let currentAnalysisScope = "general";
let predictionYear = 2025;
let predictionMonth = "";
let isPredicting = false;
let displayMode = "normal";
let currentTheme = "dark";
let crimePanelPinned = false;
let lastAppliedFilters = null;
let previousAppliedFilters = null;
let isShowingPreviousFilters = false;

document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    wireFilterControls();
    initMap();
    refreshDashboard();

    const themeBtn = document.getElementById("themeToggleBtn");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);

    const crimePanel = document.getElementById("crimeOverlayPanel");
    const crimeToggle = document.getElementById("crimeOverlayToggle");
    if (crimeToggle) crimeToggle.addEventListener("click", toggleCrimeOverlayPanel);
    if (crimePanel) {
        crimePanel.addEventListener("mouseenter", () => expandCrimeOverlayPanel(true));
        crimePanel.addEventListener("mouseleave", () => expandCrimeOverlayPanel(crimePanelPinned));
        crimePanel.addEventListener("focusin", () => expandCrimeOverlayPanel(true));
        crimePanel.addEventListener("focusout", () => expandCrimeOverlayPanel(crimePanelPinned));
    }

    const predictBtn = document.getElementById("predictBtn");
    if (predictBtn) predictBtn.addEventListener("click", () => predictAndShow(null, "panel"));

    const resetBtn = document.getElementById("resetBtn");
    if (resetBtn) resetBtn.addEventListener("click", resetToNormal);

    const slider = document.getElementById("hourSlider");
    if (slider) {
        slider.addEventListener("input", (e) => {
            currentHour = parseInt(e.target.value, 10);
            const hourValue = document.getElementById("hourValue");
            if (hourValue) {
                hourValue.innerText = `${currentHour.toString().padStart(2, "0")}:00`;
            }
        });
    }

    const predictionYearFilter = document.getElementById("predictionYearFilter");
    if (predictionYearFilter) {
        predictionYear = parseInt(predictionYearFilter.value, 10) || (currentYear + 1);
        predictionYearFilter.addEventListener("change", (event) => {
            predictionYear = parseInt(event.target.value, 10) || (currentYear + 1);
        });
    }

    const predictionMonthFilter = document.getElementById("predictionMonthFilter");
    if (predictionMonthFilter) {
        predictionMonth = predictionMonthFilter.value || "";
        predictionMonthFilter.addEventListener("change", (event) => {
            predictionMonth = event.target.value || "";
        });
    }
});

function wireFilterControls() {
    // Conecta los controles del panel lateral con la lógica del mapa.
    const applyBtn = document.getElementById("applyFilterBtn");
    if (applyBtn) applyBtn.addEventListener("click", applyMapFilters);

    const clearBtn = document.getElementById("clearFilterBtn");
    if (clearBtn) clearBtn.addEventListener("click", clearMapFilters);

    const previousBtn = document.getElementById("previousFilterBtn");
    if (previousBtn) previousBtn.addEventListener("click", restorePreviousFilters);
    updatePreviousFilterButton();

    const yearFilter = document.getElementById("yearFilter");
    if (yearFilter) {
        yearFilter.value = String(currentYear);
        yearFilter.addEventListener("change", (event) => {
            currentYear = parseInt(event.target.value, 10) || 2024;
            updateMapBanner();
        });
    }

    const viewModeFilter = document.getElementById("viewModeFilter");
    if (viewModeFilter) {
        viewModeFilter.value = currentViewMode;
        viewModeFilter.addEventListener("change", (event) => {
            currentViewMode = event.target.value;
            displayMode = currentViewMode === "prediction" ? "prediction" : "normal";
            updateMapBanner();
            updateModeIndicator(displayMode, currentHour);
        });
    }

    const analysisScopeFilter = document.getElementById("analysisScopeFilter");
    if (analysisScopeFilter) {
        analysisScopeFilter.value = currentAnalysisScope;
        analysisScopeFilter.addEventListener("change", (event) => {
            currentAnalysisScope = ["monthly", "hourly"].includes(event.target.value) ? event.target.value : "general";
            updateMapBanner();
            updateModeIndicator(displayMode, currentHour);
        });
    }

    const viewMonthFilter = document.getElementById("viewMonthFilter");
    if (viewMonthFilter) {
        viewMonthFilter.value = currentViewMonth;
        viewMonthFilter.addEventListener("change", (event) => {
            currentViewMonth = event.target.value || "";
        });
    }

    const viewHourFilter = document.getElementById("viewHourFilter");
    if (viewHourFilter) {
        viewHourFilter.value = currentViewHour;
        viewHourFilter.addEventListener("change", (event) => {
            currentViewHour = event.target.value || "";
        });
    }

    const dateInputs = [document.getElementById("startDateFilter"), document.getElementById("endDateFilter")].filter(Boolean);
    dateInputs.forEach((input) => {
        input.addEventListener("keydown", preventManualDateInput);
        input.addEventListener("paste", preventManualDateInput);
    });
}

// Inicializa el mapa Leaflet del panel principal.
async function initMap() {
    map = L.map("map").setView([8.98, -79.52], 12);
    setBaseLayer(currentTheme);
    updateMapBanner();
}

// Recupera el tema guardado por el usuario y lo aplica al inicio.
function initTheme() {
    const savedTheme = localStorage.getItem("mapTheme");
    currentTheme = savedTheme === "light" ? "light" : "dark";
    applyTheme(currentTheme);
}

// Alterna entre modo claro y modo oscuro en toda la interfaz.
function toggleTheme() {
    currentTheme = currentTheme === "dark" ? "light" : "dark";
    localStorage.setItem("mapTheme", currentTheme);
    applyTheme(currentTheme);
    setBaseLayer(currentTheme);
    updateThemeButton();
}

// Escribe el tema activo en el documento para que el CSS lo use.
function applyTheme(theme) {
    document.body.dataset.theme = theme;
    updateThemeButton();
}

// Actualiza el texto del botón según el tema que está activo.
function updateThemeButton() {
    const themeBtn = document.getElementById("themeToggleBtn");
    if (!themeBtn) return;
    themeBtn.textContent = currentTheme === "dark" ? "Modo claro" : "Modo noche";
}

// Cambia la capa base del mapa según el tema visual seleccionado.
function setBaseLayer(theme) {
    if (!map) return;
    const isLight = theme === "light";
    const url = isLight
        ? "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
    if (baseLayer) {
        map.removeLayer(baseLayer);
    }
    baseLayer = L.tileLayer(url, {
        attribution: "OpenStreetMap contributors",
        subdomains: "abcd",
        maxZoom: 19,
    }).addTo(map);
}

// Bloquea la escritura manual en los campos de fecha para evitar formatos inválidos.
function preventManualDateInput(event) {
    event.preventDefault();
}

function getActiveFilters() {
    // Reúne el estado actual de los filtros visibles en la interfaz.
    const crime = document.getElementById("crimeFilter")?.value || "todos";
    const startDate = normalizeDateInput(document.getElementById("startDateFilter")?.value || "");
    const endDate = normalizeDateInput(document.getElementById("endDateFilter")?.value || "");
    const year = document.getElementById("yearFilter")?.value || String(currentYear);
    const viewMode = document.getElementById("viewModeFilter")?.value || currentViewMode;
    const analysisScope = document.getElementById("analysisScopeFilter")?.value || currentAnalysisScope;
    const month = document.getElementById("viewMonthFilter")?.value || currentViewMonth || "";
    const hour = document.getElementById("viewHourFilter")?.value || currentViewHour || "";
    return { crime, startDate, endDate, year, viewMode, analysisScope, month, hour };
}

// Resume en una sola línea los filtros que están activos.
function updateActiveFilterSummary(filters) {
    const target = document.getElementById("activeFilterSummary");
    if (!target) return;

    const parts = [];
    if (filters.year) parts.push(`Año: ${filters.year}`);
    if (filters.viewMode === "prediction") parts.push("Modo: predicciones");
    if (filters.viewMode === "real") parts.push("Modo: datos recolectados");
    parts.push(`Alcance: ${filters.analysisScope === "monthly" ? "mes" : filters.analysisScope === "hourly" ? "hora" : "general"}`);
    if (filters.month) parts.push(`Mes: ${monthNameFromValue(filters.month)}`);
    if (filters.hour) parts.push(`Hora: ${String(filters.hour).padStart(2, "0")}:00`);
    if (filters.crime && filters.crime !== "todos") parts.push(`Crimen: ${filters.crime}`);
    if (filters.startDate) parts.push(`Desde ${filters.startDate}`);
    if (filters.endDate) parts.push(`Hasta ${filters.endDate}`);

    target.textContent = parts.length ? `Filtro activo: ${parts.join(" | ")}` : "Mostrando todos los incidentes del dataset";
}

// Abre o cierra el panel flotante con el detalle del delito.
function toggleCrimeOverlayPanel(event) {
    if (event) event.preventDefault();
    crimePanelPinned = !crimePanelPinned;
    expandCrimeOverlayPanel(crimePanelPinned);
    const toggle = document.getElementById("crimeOverlayToggle");
    if (toggle) toggle.textContent = crimePanelPinned ? "Ocultar" : "Detalles";
}

// Cambia el tamaño del panel de delitos y reajusta el gráfico.
function expandCrimeOverlayPanel(expanded) {
    const panel = document.getElementById("crimeOverlayPanel");
    if (!panel) return;
    panel.classList.toggle("expanded", Boolean(expanded));
    panel.classList.toggle("collapsed", !expanded);
    if (crimeChart) {
        requestAnimationFrame(() => crimeChart.resize());
    }
}

// Convierte los filtros visibles en parámetros de consulta para la API.
function buildQueryString(filters = {}) {
    const params = new URLSearchParams();
    if (filters.year) params.set("year", filters.year);
    if (filters.month) params.set("month", filters.month);
    if (filters.hour) params.set("hour", filters.hour);
    if (filters.crime && filters.crime !== "todos") params.set("crime", filters.crime);
    if (filters.startDate) params.set("start_date", filters.startDate);
    if (filters.endDate) params.set("end_date", filters.endDate);
    return params.toString() ? `?${params.toString()}` : "";
}

// Limpia la capa anterior antes de pintar nuevos puntos en el mapa.
function clearLayer() {
    if (currentLayer) {
        map.removeLayer(currentLayer);
        currentLayer = null;
    }
}

function renderFeatureCollection(data, mode, hour = null) {
    // Convierte el GeoJSON que entrega la API en puntos visibles sobre Leaflet.
    clearLayer();

    if (!data.features || data.features.length === 0) {
        return;
    }

    const group = L.layerGroup();
    const predictionMode = data?.metadata?.mode || (hour === null ? "general" : "hourly");

    data.features.forEach((feature) => {
        const intensity = feature.properties?.intensidad || 50;
        const lat = feature.geometry.coordinates[1];
        const lng = feature.geometry.coordinates[0];

        let color = "#ffcc00";
        let radius = 7;
        const isPrediction = mode === "prediccion" || mode === "prediction";

        if (isPrediction) {
            color = intensity >= 70 ? "#ff0000" : intensity >= 40 ? "#ff6600" : "#ffcc00";
            radius = 12;
        } else {
            if (intensity > 70) {
                color = "#ff0000";
                radius = 12;
            } else if (intensity > 40) {
                color = "#ff6600";
                radius = 9;
            }
        }

        const circle = L.circleMarker([lat, lng], {
            radius,
            fillColor: color,
            color: "#ffffff",
            weight: 1.5,
            opacity: 0.9,
            fillOpacity: 0.8,
        });

        const zone = feature.properties?.zona || feature.properties?.corregimiento || "Zona urbana";
        const risk = feature.properties?.riesgo || "Medio";
        const crime = feature.properties?.crimen || "No especificado";
        const predictedIncidents = feature.properties?.predicted_incidents;

        let popupContent = `<b>${zone}</b><br>Riesgo: ${risk}<br>`;
        if (isPrediction) {
            if (predictionMode === "general") {
                popupContent += "Predicción general del siguiente año<br>";
            } else {
                popupContent += `Predicción para las ${String(hour).padStart(2, "0")}:00<br>`;
            }
            if (predictedIncidents !== undefined) {
                popupContent += `Incidentes esperados: ${Number(predictedIncidents).toFixed(2)}<br>`;
            }
        } else {
            popupContent += `Hora registrada: ${feature.properties?.hora}:00<br>`;
            popupContent += `Crimen: ${crime}`;
        }

        circle.bindPopup(popupContent);
        circle.addTo(group);
    });

    group.addTo(map);
    currentLayer = group;

    const layers = group.getLayers();
    if (layers.length > 0) {
        const bounds = L.latLngBounds(layers.map((marker) => marker.getLatLng()));
        map.fitBounds(bounds);
    }
}

// Hace una consulta GET simple y valida la respuesta HTTP.
async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

// Obtiene los puntos del mapa según el alcance normal o por hora.
async function fetchHeatmapData(filters) {
    if ((filters.analysisScope || currentAnalysisScope) === "hourly") {
        const response = await fetch("/api/heatmap/filter", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                hour: currentHour,
                crime: filters.crime,
                start_date: filters.startDate,
                end_date: filters.endDate,
                year: filters.year,
            }),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    return fetchJson(`/api/heatmap${buildQueryString(filters)}`);
}

// Recarga el mapa principal con los datos actuales de filtrado.
async function loadAllData() {
    try {
        const filters = getActiveFilters();
        const data = await fetchHeatmapData(filters);
        renderFeatureCollection(data, "normal");
        updateModeIndicator("normal");
        updateActiveFilterSummary(filters);
        updateMapBanner(filters);
    } catch (error) {
        console.error("ERROR:", error);
        showMessage("Error cargando datos", "error");
    }
}

// Refresca al mismo tiempo el mapa, los gráficos y los resúmenes.
async function refreshDashboard() {
    const filters = getActiveFilters();
    await Promise.all([
        loadStats(filters),
        loadChart(filters),
        loadCrimeChart(filters),
        loadAllData(),
    ]);
}

async function applyMapFilters() {
    // Aplica los filtros seleccionados y recarga las capas visibles.
    const filters = getActiveFilters();
    const viewModeFilter = document.getElementById("viewModeFilter");
    if (viewModeFilter) viewModeFilter.value = filters.viewMode || "real";
    return runMapFilters(filters, { recordHistory: true });
}

async function runMapFilters(filters, { recordHistory = false } = {}) {
    // Ejecuta la actualización completa del mapa y sus paneles.
    if (recordHistory) {
        if (lastAppliedFilters) {
            previousAppliedFilters = { ...lastAppliedFilters };
        }
        lastAppliedFilters = { ...filters };
        isShowingPreviousFilters = false;
        updatePreviousFilterButton();
    }

    currentViewMode = filters.viewMode || "real";
    currentAnalysisScope = filters.analysisScope || "general";
    displayMode = currentViewMode === "prediction" ? "prediction" : "normal";
    updateActiveFilterSummary(filters);
    updateMapBanner(filters);

    if (currentViewMode === "prediction") {
        await predictAndShow(filters, "map");
        return;
    }

    await loadAllData();
    await loadStats(filters);
    await loadChart(filters);
    await loadCrimeChart(filters);
    showMessage("Filtro aplicado", "success");
}

async function clearMapFilters() {
    // Restablece todos los filtros del mapa a su estado inicial.
    const crimeFilter = document.getElementById("crimeFilter");
    const startDateFilter = document.getElementById("startDateFilter");
    const endDateFilter = document.getElementById("endDateFilter");
    const yearFilter = document.getElementById("yearFilter");
    const viewModeFilter = document.getElementById("viewModeFilter");
    const analysisScopeFilter = document.getElementById("analysisScopeFilter");
    const viewMonthFilter = document.getElementById("viewMonthFilter");
    const viewHourFilter = document.getElementById("viewHourFilter");
    if (crimeFilter) crimeFilter.value = "todos";
    if (startDateFilter) startDateFilter.value = "";
    if (endDateFilter) endDateFilter.value = "";
    if (yearFilter) yearFilter.value = "2024";
    if (viewModeFilter) viewModeFilter.value = "real";
    if (analysisScopeFilter) analysisScopeFilter.value = "general";
    if (viewMonthFilter) viewMonthFilter.value = "";
    if (viewHourFilter) viewHourFilter.value = "";

    currentYear = 2024;
    currentViewMonth = "";
    currentViewHour = "";
    currentViewMode = "real";
    currentAnalysisScope = "general";
    isShowingPreviousFilters = false;
    previousAppliedFilters = lastAppliedFilters ? { ...lastAppliedFilters } : null;
    lastAppliedFilters = {
        crime: "todos",
        startDate: "",
        endDate: "",
        year: String(currentYear),
        viewMode: currentViewMode,
        analysisScope: currentAnalysisScope,
        month: "",
        hour: "",
    };
    displayMode = "normal";
    updateModeIndicator("normal");
    updateMapBanner();
    updatePreviousFilterButton();
    await loadAllData();
    await loadStats();
    await loadChart();
    await loadCrimeChart();
    showMessage("Filtros limpiados", "success");
}

async function restorePreviousFilters() {
    // Alterna entre el filtro aplicado más reciente y el anterior.
    if (!lastAppliedFilters && !previousAppliedFilters) {
        showMessage("No hay filtros guardados para comparar", "warning");
        return;
    }

    const targetFilters = isShowingPreviousFilters
        ? (lastAppliedFilters || previousAppliedFilters)
        : (previousAppliedFilters || lastAppliedFilters);

    if (!targetFilters) {
        showMessage("No hay un filtro anterior guardado", "warning");
        return;
    }

    isShowingPreviousFilters = !isShowingPreviousFilters;
    applyFiltersToControls(targetFilters);
    updatePreviousFilterButton();
    await runMapFilters(targetFilters, { recordHistory: false });
}

function applyFiltersToControls(filters) {
    // Sincroniza los controles visuales con un conjunto de filtros guardado.
    const crimeFilter = document.getElementById("crimeFilter");
    const startDateFilter = document.getElementById("startDateFilter");
    const endDateFilter = document.getElementById("endDateFilter");
    const yearFilter = document.getElementById("yearFilter");
    const viewModeFilter = document.getElementById("viewModeFilter");
    const analysisScopeFilter = document.getElementById("analysisScopeFilter");
    const viewMonthFilter = document.getElementById("viewMonthFilter");
    const viewHourFilter = document.getElementById("viewHourFilter");
    const hourSlider = document.getElementById("hourSlider");
    const hourValue = document.getElementById("hourValue");

    if (crimeFilter && filters.crime !== undefined) crimeFilter.value = filters.crime || "todos";
    if (startDateFilter && filters.startDate !== undefined) startDateFilter.value = filters.startDate || "";
    if (endDateFilter && filters.endDate !== undefined) endDateFilter.value = filters.endDate || "";
    if (yearFilter && filters.year !== undefined) yearFilter.value = String(filters.year || currentYear);
    if (viewModeFilter && filters.viewMode !== undefined) viewModeFilter.value = filters.viewMode || "real";
    if (analysisScopeFilter && filters.analysisScope !== undefined) analysisScopeFilter.value = filters.analysisScope || "general";
    if (viewMonthFilter && filters.month !== undefined) viewMonthFilter.value = filters.month || "";
    if (viewHourFilter && filters.hour !== undefined) viewHourFilter.value = filters.hour || "";

    if (filters.month !== undefined) currentViewMonth = filters.month || "";
    if (filters.hour !== undefined) currentViewHour = filters.hour || "";
}

function updatePreviousFilterButton() {
    // Cambia el texto del botón para reflejar qué filtro se muestra.
    const button = document.getElementById("previousFilterBtn");
    if (!button) return;

    if (!lastAppliedFilters && !previousAppliedFilters) {
        button.textContent = "Filtro anterior";
        button.disabled = true;
        return;
    }

    button.disabled = false;
    const currentLabel = String(lastAppliedFilters?.year || currentYear);
    const previousLabel = String(previousAppliedFilters?.year || currentYear);
    button.textContent = isShowingPreviousFilters ? `Volver a ${currentLabel}` : `Ver ${previousLabel}`;
}

function getThemeTextColor() {
    return currentTheme === "light" ? "#2f3e46" : "#eee";
}

function getThemeGridColor() {
    return currentTheme === "light" ? "rgba(82, 121, 111, 0.18)" : "rgba(255,255,255,0.18)";
}

async function predictAndShow(sourceFilters = null, source = "panel") {
    if (isPredicting) return;
    isPredicting = true;
    displayMode = "prediction";

    // Separamos la predicción del panel lateral y la disparada desde el filtro del mapa.
    const usingFilterView = source === "map" && Boolean(sourceFilters);
    const panelYearValue = document.getElementById("predictionYearFilter")?.value || predictionYear || (currentYear + 1);
    const panelMonthValue = document.getElementById("predictionMonthFilter")?.value || predictionMonth || "";
    const panelHourValue = document.getElementById("hourSlider")?.value || currentHour;
    const predictionHour = usingFilterView
        ? (sourceFilters.hour !== undefined && sourceFilters.hour !== "" ? Number(sourceFilters.hour) : null)
        : (panelHourValue !== "" ? Number(panelHourValue) : null);
    const targetYear = usingFilterView
        ? Number(sourceFilters.year || currentYear)
        : Number(panelYearValue);
    const targetMonth = usingFilterView
        ? String(sourceFilters.month || "")
        : String(panelMonthValue);
    const targetDate = targetMonth
        ? `${String(targetYear)}-${String(targetMonth).padStart(2, "0")}-01`
        : null;
    const predictionScope = predictionHour !== null && predictionHour !== undefined
        ? "hourly"
        : (targetMonth ? "monthly" : "general");
    if (usingFilterView) {
        // Solo la vista del mapa sincroniza el modo global cuando se pide desde el filtro principal.
        currentViewMode = "prediction";
        const viewModeFilter = document.getElementById("viewModeFilter");
        if (viewModeFilter) viewModeFilter.value = "prediction";
        currentAnalysisScope = sourceFilters.analysisScope || predictionScope;
    }
    updateMapBanner(
        { year: targetYear, analysisScope: predictionScope, month: targetMonth, hour: predictionHour, viewMode: "prediction" },
        true,
        { year: targetYear, month: targetMonth, hour: predictionHour }
    );
    const hour = predictionHour;
    const btn = document.getElementById("predictBtn");
    const originalText = btn?.textContent || "";
    if (btn) {
        btn.textContent = "Cargando...";
        btn.disabled = true;
    }

    try {
        const requestBody = {
            year: String(targetYear),
        };
        // El backend usa este payload para calcular zonas y hotspots predichos.
        requestBody.mode = hour === null || hour === undefined ? "general" : "hourly";
        if (hour !== null && hour !== undefined && hour !== "") {
            requestBody.hour = hour;
        }
        if (targetMonth) {
            requestBody.month = targetMonth;
            requestBody.date = targetDate;
        }
        if (usingFilterView) {
            if (sourceFilters.crime && sourceFilters.crime !== "todos") requestBody.crime = sourceFilters.crime;
            if (sourceFilters.startDate) requestBody.start_date = sourceFilters.startDate;
            if (sourceFilters.endDate) requestBody.end_date = sourceFilters.endDate;
            if (sourceFilters.month) requestBody.month = sourceFilters.month;
            if (sourceFilters.hour !== undefined && sourceFilters.hour !== "") requestBody.hour = sourceFilters.hour;
        }

        const textResponse = await fetch("/api/predict/zones", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (!textResponse.ok) throw new Error(`HTTP ${textResponse.status}`);
        const textData = await textResponse.json();

        const hotspotResponse = await fetch("/api/predict/hotspots", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...requestBody, top_n: 20 }),
        });

        if (!hotspotResponse.ok) throw new Error(`HTTP ${hotspotResponse.status}`);
        const hotspotData = await hotspotResponse.json();

        if (!Array.isArray(textData) || textData.length === 0 || !hotspotData?.features?.length) {
            document.getElementById("zonePrediction").innerHTML = '<div class="predicted-zone">No hay datos suficientes para predecir.</div>';
            renderFeatureCollection({ features: [] }, "prediccion", hour);
            updateModeIndicator("prediccion", hour, predictionScope, { year: targetYear, month: targetMonth });
            showMessage("No hay datos suficientes para predecir.", "warning");
            return;
        }

        if (textData && textData.length > 0) {
            // Construye el resumen lateral con las zonas más activas.
            const scopeLabel = hour !== null && hour !== undefined ? `a las ${String(hour).padStart(2, "0")}:00` : "en vista general";
            const monthLabel = targetMonth ? monthNameForPrediction(targetMonth) : "todo el año";
            let html = `<div style="text-align:center; margin-bottom:10px; font-weight:bold;">Zonas con mayor actividad ${scopeLabel} | ${targetYear} | ${monthLabel}</div>`;
            textData.forEach((zone, index) => {
                const percent = (zone.probabilidad * 100).toFixed(1);
                html += `
                    <div class="predicted-zone">
                        <b>${zone.zona}</b>
                        ${index === 0 ? '<span class="top-risk-badge">MAS ACTIVA</span>' : ""}
                        <div class="risk-bar" style="width: ${percent}%;"></div>
                        <div>Actividad relativa: <b>${percent}%</b> (${zone.incidentes} casos)</div>
                    </div>
                `;
            });
            document.getElementById("zonePrediction").innerHTML = html;
        }

        if (hotspotData && hotspotData.features) {
            
            // Dibuja las zonas predichas sobre el mapa principal.
            renderFeatureCollection(hotspotData, "prediccion", hour);
            updateModeIndicator("prediccion", hour, predictionScope, { year: targetYear, month: targetMonth });
        } else {
            showMessage("No hay datos suficientes para predecir.", "warning");
        }

        updateActiveFilterSummary({
            year: targetYear,
            viewMode: "prediction",
            analysisScope: predictionScope,
            month: targetMonth,
            hour: hour === null || hour === undefined ? "" : hour,
        });
    } catch (error) {
        console.error("ERROR:", error);
        showMessage("Error en la predicción", "error");
    } finally {
        if (btn) {
            btn.textContent = originalText;
            btn.disabled = false;
        }
        isPredicting = false;
    }
}

// Vuelve a la vista normal y limpia la capa de predicciones.
async function resetToNormal() {
    const zonePrediction = document.getElementById("zonePrediction");
    if (zonePrediction) zonePrediction.innerHTML = "";
    const viewModeFilter = document.getElementById("viewModeFilter");
    if (viewModeFilter) viewModeFilter.value = "real";
    const analysisScopeFilter = document.getElementById("analysisScopeFilter");
    if (analysisScopeFilter) analysisScopeFilter.value = "general";
    displayMode = "normal";
    currentViewMode = "real";
    currentAnalysisScope = "general";
    await clearMapFilters();
}

// Muestra una notificación temporal en pantalla.
function showMessage(message, type) {
    const toast = document.createElement("div");
    toast.className = "toast-notification";
    if (type === "warning") toast.classList.add("warning");
    if (type === "error") toast.classList.add("error");
    toast.innerHTML = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

async function loadStats(filters = {}) {
    // Consulta el resumen general y actualiza tarjetas, textos y gráficos.
    try {
        const data = await fetchJson(`/api/summary${buildQueryString(filters)}`);
        const total = data.total_incidentes || 0;
        const peakHour = formatPeakHourSummary(data);
        const topZone = data.zona_mas_riesgosa || "Desconocida";
        const crimeTypes = data.distribucion_crimen ? Object.keys(data.distribucion_crimen).length : 0;

        const kpiGrid = document.getElementById("kpiGrid");
        if (kpiGrid) {
            kpiGrid.innerHTML = `
                <div class="kpi-card">
                    <span class="kpi-label">Incidentes</span>
                    <div class="kpi-value">${total.toLocaleString()}</div>
                    <span class="kpi-note">Registros procesados</span>
                </div>
                <div class="kpi-card">
                    <span class="kpi-label">Hora pico</span>
                    <div class="kpi-value">${peakHour}</div>
                    <span class="kpi-note">Mayor presión histórica</span>
                </div>
                <div class="kpi-card">
                    <span class="kpi-label">Zona crítica</span>
                    <div class="kpi-value">${topZone}</div>
                    <span class="kpi-note">Más eventos registrados</span>
                </div>
                <div class="kpi-card">
                    <span class="kpi-label">Tipos de crimen</span>
                    <div class="kpi-value">${crimeTypes}</div>
                    <span class="kpi-note">Categorías observadas</span>
                </div>
            `;
        }

        const statsContent = document.getElementById("stats-content");
        if (statsContent) {
            statsContent.innerHTML = `
                <div class="stat-item" style="background:linear-gradient(90deg, rgba(233,69,96,0.35), rgba(255,159,67,0.2)); margin-bottom:10px;">
                    <b>Resumen territorial</b>
                </div>
                <div class="stat-item">Alcance: <b>${data.alcance_datos || "General"}</b></div>
                <div class="stat-item">Total incidentes: <b>${total}</b></div>
                <div class="stat-item">Hora pico: <b>${peakHour}</b></div>
                <div class="stat-item">Zona mas riesgosa: <b>${topZone}</b></div>
                <div class="info-text" style="margin-top:10px;">Pulsa "Estadísticas" para abrir el reporte completo</div>
            `;
        }

        const sourcePill = document.getElementById("dataSourcePill");
        if (sourcePill) {
            sourcePill.textContent = "Fuente: datos procesados localmente";
        }

        const updatedPill = document.getElementById("lastUpdatedPill");
        if (updatedPill) {
            updatedPill.textContent = `Última carga: ${new Date().toLocaleTimeString()}`;
        }

        updateModeIndicator(displayMode, currentHour);
    } catch (error) {
        console.error("Error:", error);
    }
}

async function loadChart(filters = {}) {
    // Dibuja la curva horaria del riesgo usando la respuesta del backend.
    try {
        const data = await fetchJson(`/api/predict/hour${buildQueryString(filters)}`);

        const ctx = document.getElementById("hourChart")?.getContext("2d");
        if (!ctx) return;
        if (riskChart) riskChart.destroy();

        riskChart = new Chart(ctx, {
            type: "line",
            data: {
                labels: data.horas.map((h) => `${h}:00`),
                datasets: [
                    {
                        label: "Riesgo (%)",
                        data: data.riesgo_predicho,
                        borderColor: "#e94560",
                        backgroundColor: "rgba(233,69,96,0.1)",
                        fill: true,
                        tension: 0.3,
                        pointRadius: 3,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: { legend: { labels: { color: getThemeTextColor() } } },
                scales: {
                    y: { ticks: { color: getThemeTextColor() } },
                    x: { ticks: { color: getThemeTextColor(), rotation: 45 } },
                },
            },
        });

        const peakHour = document.getElementById("peak-hour");
        if (peakHour) peakHour.innerHTML = `Pico maximo: <b>${data.peak_hour}:00</b>`;
    } catch (error) {
        console.error("Error:", error);
    }
}

async function loadCrimeChart(filters = {}) {
    // Construye el gráfico circular con la distribución de delitos.
    try {
        const data = await fetchJson(`/api/summary${buildQueryString(filters)}`);
        const crimeData = data.distribucion_crimen || {};
        const labels = Object.keys(crimeData);
        const values = Object.values(crimeData);

        const ctx = document.getElementById("crimeChart")?.getContext("2d");
        if (!ctx) return;
        if (crimeChart) crimeChart.destroy();

        crimeChart = new Chart(ctx, {
            type: "doughnut",
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: ["#e94560", "#ff9f43", "#ffd93d", "#4caf50", "#4a90e2", "#9b59b6"],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: getThemeTextColor() } }
                }
            }
        });

        requestAnimationFrame(() => {
            if (crimeChart) crimeChart.resize();
        });

        updateCrimePreview(crimeData);
    } catch (error) {
        console.error("Error:", error);
    }
}

// Resume en texto los delitos más frecuentes del gráfico lateral.
function updateCrimePreview(crimeData) {
    const preview = document.getElementById("crimeOverlayPreview");
    if (!preview) return;

    const entries = Object.entries(crimeData || {});
    if (!entries.length) {
        preview.textContent = "Sin datos de delitos para el filtro actual.";
        return;
    }

    const knownOrder = ["Robo", "Homicidio", "Femicidio"];
    const knownEntries = knownOrder.map((crime) => [crime, Number(crimeData?.[crime] || 0)]);
    const hasKnownData = knownEntries.some(([, count]) => Number(count) > 0);
    const sourceEntries = hasKnownData
        ? knownEntries
        : entries.sort((a, b) => Number(b[1]) - Number(a[1]));

    const total = sourceEntries.reduce((sum, [, count]) => sum + Number(count || 0), 0);
    if (!total) {
        preview.textContent = "Sin datos de delitos para el filtro actual.";
        return;
    }

    const topThree = sourceEntries.slice(0, 3).map(([crime, count]) => {
        const pct = total ? Math.round((Number(count) / total) * 100) : 0;
        return `${crime} ${pct}%`;
    });
    preview.textContent = topThree.join(" | ");
}

// Explica en pantalla si se está viendo datos reales o predicciones.
function updateModeIndicator(mode, hour = null, scope = currentAnalysisScope, predictionLabel = {}) {
    const indicator = document.getElementById("modeIndicator");
    if (!indicator) return;

    if (mode === "prediccion" || mode === "prediction") {
        indicator.className = "mode-indicator prediction";
        const yearText = predictionLabel.year ? ` | Año objetivo ${predictionLabel.year}` : "";
        const monthText = predictionLabel.month ? ` | Mes ${monthNameForPrediction(predictionLabel.month)}` : "";
        if (scope === "hourly" && hour !== null) {
            indicator.innerHTML = `MODO PREDICCION - Hotspots estimados para las ${String(hour).padStart(2, "0")}:00${yearText}${monthText}<br><span style="font-size: 0.8rem;">Los circulos resaltados son zonas de mayor riesgo esperado</span>`;
        } else if (scope === "monthly") {
            const monthName = predictionLabel.month ? monthNameForPrediction(predictionLabel.month) : "sin mes";
            indicator.innerHTML = `MODO PREDICCION - Vista estimada para el mes ${monthName}${yearText}${monthText}<br><span style="font-size: 0.8rem;">Los circulos resaltados son zonas de mayor riesgo esperado</span>`;
        } else {
            indicator.innerHTML = `MODO PREDICCION - Vista general del siguiente año${yearText}${monthText}<br><span style="font-size: 0.8rem;">Los circulos resaltados son zonas de mayor riesgo esperado</span>`;
        }
    } else {
        indicator.className = "mode-indicator normal";
        if (scope === "monthly") {
            const monthText = currentViewMonth ? monthNameFromValue(currentViewMonth) : "sin seleccionar";
            indicator.innerHTML = `MODO NORMAL - Mostrando incidentes del mes ${monthText}<br><span style="font-size: 0.8rem;">Usa el filtro de mes para cambiar la vista</span>`;
        } else if (scope === "hourly") {
            const visibleHour = currentViewHour || "";
            indicator.innerHTML = visibleHour
                ? `MODO NORMAL - Mostrando incidentes a las ${String(visibleHour).padStart(2, "0")}:00<br><span style="font-size: 0.8rem;">Usa el filtro de hora para cambiar la vista</span>`
                : `MODO NORMAL - Hora sin seleccionar<br><span style="font-size: 0.8rem;">Usa el filtro de hora para cambiar la vista</span>`;
        } else {
            indicator.innerHTML = `MODO NORMAL - Mostrando todos los incidentes recolectados<br><span style="font-size: 0.8rem;">Usa el slider para explorar predicciones</span>`;
        }
    }
}

// Formatea la hora pico a partir del resumen devuelto por la API.
function formatPeakHourSummary(data) {
    const direct = Number(data?.pico_hora);
    if (Number.isFinite(direct)) {
        return `${String(direct).padStart(2, "0")}:00`;
    }

    const hourCounts = data?.distribucion_hora || {};
    const entries = Object.entries(hourCounts);
    if (!entries.length) return "Sin datos";
    const peak = Number(entries.sort((a, b) => Number(b[1]) - Number(a[1]))[0][0]);
    return `${String(peak).padStart(2, "0")}:00`;
}

function updateMapBanner(filters = getActiveFilters(), forcePrediction = false, predictionMeta = {}) {
    // Muestra el contexto visible del mapa arriba del lienzo principal.
    const banner = document.getElementById("mapBanner");
    if (!banner) return;

    const isPrediction = forcePrediction || (filters.viewMode || currentViewMode) === "prediction";
    const year = filters.year || currentYear;
    const monthValue = filters.month || predictionMeta.month || "";
    const hourValue = filters.hour !== undefined && filters.hour !== ""
        ? filters.hour
        : (predictionMeta.hour !== undefined && predictionMeta.hour !== null ? predictionMeta.hour : currentViewHour);
    const hasMonth = Boolean(monthValue);
    const hasHour = hourValue !== "" && hourValue !== null && hourValue !== undefined;
    const scopeLabel = hasMonth && hasHour
        ? `mes ${monthNameFromValue(monthValue)} | hora ${String(hourValue).padStart(2, "0")}:00`
        : hasMonth
            ? `mes ${monthNameFromValue(monthValue)}`
            : hasHour
                ? `hora ${String(hourValue).padStart(2, "0")}:00`
                : "vista general";

    banner.classList.toggle("prediction-active", Boolean(isPrediction));
    if (isPrediction) {
        const monthLabel = predictionMeta.month ? ` | Mes ${monthNameForPrediction(predictionMeta.month)}` : "";
        const hourLabel = predictionMeta.hour !== undefined && predictionMeta.hour !== null
            ? ` | Hora ${String(predictionMeta.hour).padStart(2, "0")}:00`
            : "";
        const targetYear = predictionMeta.year || year;
        banner.textContent = `Visualizando predicciones del siguiente año. Año objetivo ${targetYear}${monthLabel}${hourLabel} | ${scopeLabel}`;
        banner.classList.remove("hidden");
    } else {
        banner.textContent = `Visualizando datos recolectados del año ${year} | ${scopeLabel}`;
        banner.classList.remove("hidden");
    }
}

// Convierte el número del mes en un nombre legible para la interfaz.
function monthNameFromValue(month) {
    const names = {
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
    return names[String(month)] || "Todos los meses";
}

// Reutiliza el nombre del mes para los textos de predicción.
function monthNameForPrediction(month) {
    return monthNameFromValue(month);
}

// Normaliza fechas escritas en formatos comunes al formato ISO.
function normalizeDateInput(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

    const match = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!match) return trimmed;

    const day = String(match[1]).padStart(2, "0");
    const month = String(match[2]).padStart(2, "0");
    const year = match[3];
    return `${year}-${month}-${day}`;
}
