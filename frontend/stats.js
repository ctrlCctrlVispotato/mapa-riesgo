// Lógica de la página de estadísticas: filtros, comparaciones, gráficos y métricas.
let statsHourChart = null;
let statsCrimeChart = null;
let statsYearChart = null;
let statsMonthChart = null;
let allRows = [];
let filteredRows = [];
let modelEvaluation = null;
let modelEvaluationIsStale = false;
let evaluationPollTimer = null;
let currentTheme = "dark";
let baseSummary = {};
const MODEL_EVALUATION_CACHE_KEY = "modelEvaluation:v3";

// Carga la página de estadísticas y conecta los filtros interactivos.
document.addEventListener("DOMContentLoaded", async () => {
    initTheme();
    await loadStatsPage();
    const zoneFilter = document.getElementById("zoneFilter");
    if (zoneFilter) zoneFilter.addEventListener("change", handleZoneFilterChange);

    const dateViewFilter = document.getElementById("dateViewFilter");
    if (dateViewFilter) dateViewFilter.addEventListener("change", rerenderFromCurrentRows);

    const hourViewFilter = document.getElementById("hourViewFilter");
    if (hourViewFilter) hourViewFilter.addEventListener("change", rerenderFromCurrentRows);

    const downloadBtn = document.getElementById("downloadCsvBtn");
    if (downloadBtn) downloadBtn.addEventListener("click", downloadCsvReport);

    const resetBtn = document.getElementById("resetFiltersBtn");
    if (resetBtn) resetBtn.addEventListener("click", resetFilters);

    const themeBtn = document.getElementById("themeToggleBtn");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
});

// Recupera el tema guardado y aplica el estilo correcto a la página.
function initTheme() {
    const savedTheme = localStorage.getItem("mapTheme");
    currentTheme = savedTheme === "light" ? "light" : "dark";
    applyTheme();
}

// Cambia entre modo claro y modo oscuro para esta vista.
function toggleTheme() {
    currentTheme = currentTheme === "dark" ? "light" : "dark";
    localStorage.setItem("mapTheme", currentTheme);
    applyTheme();
}

// Aplica el tema activo al documento y actualiza el botón visible.
function applyTheme() {
    document.body.dataset.theme = currentTheme;
    const themeBtn = document.getElementById("themeToggleBtn");
    if (themeBtn) themeBtn.textContent = currentTheme === "dark" ? "Modo claro" : "Modo noche";
}

// Devuelve el color de texto que mejor encaja con el tema activo.
function getThemeTextColor() {
    return currentTheme === "light" ? "#2f3e46" : "#eee";
}

// Devuelve un color secundario para textos de apoyo.
function getThemeMutedColor() {
    return currentTheme === "light" ? "#52796f" : "#ddd";
}

// Devuelve el color de las rejillas en gráficos según el tema.
function getThemeGridColor() {
    return currentTheme === "light" ? "rgba(47, 62, 70, 0.12)" : "rgba(255, 255, 255, 0.14)";
}

function loadCachedModelEvaluation() {
    try {
        const cached = JSON.parse(localStorage.getItem(MODEL_EVALUATION_CACHE_KEY) || "null");
        return cached && typeof cached === "object" ? cached : null;
    } catch {
        return null;
    }
}

function saveCachedModelEvaluation(evaluation) {
    try {
        localStorage.setItem(MODEL_EVALUATION_CACHE_KEY, JSON.stringify({
            ...evaluation,
            cached_at: new Date().toISOString(),
        }));
    } catch {
        // The app still works if browser storage is unavailable.
    }
}

function progressPercent(progress) {
    const direct = Number(progress?.percent);
    if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct));
    const completed = Number(progress?.completed_windows);
    const total = Number(progress?.total_windows);
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
        return Math.max(0, Math.min(100, (completed / total) * 100));
    }
    return 0;
}

function progressText(progress) {
    const status = String(progress?.status || "");
    if (status === "error") return "No se pudo completar el cálculo nuevo";
    if (status === "evaluating_zones") return "Evaluando zonas críticas por día y hora...";
    if (status === "training") return "Preparando el modelo para el backtest...";
    const completed = Number(progress?.completed_windows);
    const total = Number(progress?.total_windows);
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
        return `${completed.toLocaleString()} de ${total.toLocaleString()} ventanas evaluadas`;
    }
    return "El backtest se está preparando en segundo plano.";
}

function renderMetricsProgressNotice(trainYear, testYear, progress) {
    const legendTarget = document.getElementById("metricsLegend");
    if (!legendTarget) return;
    const percent = progressPercent(progress);
    legendTarget.innerHTML = `
        <div class="metrics-progress">
            <div class="metrics-progress-head">
                <b>Actualizando backtest ${trainYear} → ${testYear}</b>
                <span>${percent.toFixed(0)}%</span>
            </div>
            <div class="metrics-progress-bar"><span style="width:${percent}%;"></span></div>
            <div class="info-text">${progressText(progress)}. Mientras termina, se muestra el último cálculo guardado.</div>
        </div>
    `;
}

function renderMetricsError(message) {
    const target = document.getElementById("modelMetrics");
    if (!target) return;
    target.innerHTML = `
        <div class="comparison-card metrics-pending-card">
            <div class="kpi-label">No fue posible calcular las métricas</div>
            <div class="info-text">${escapeHtml(message || "Intenta recargar la página o revisar el servidor.")}</div>
        </div>
    `;
}

// Renders a spinner in the metrics section while the backtest computes.
function renderMetricsPending(trainYear, testYear, progress = {}) {
    const target = document.getElementById("modelMetrics");
    if (!target) return;
    const percent = progressPercent(progress);
    target.innerHTML = `
        <div class="comparison-card metrics-pending-card">
            <div class="kpi-label">Calculando métricas del modelo\u2026</div>
            <div class="metrics-progress-copy">
                Backtest ${trainYear} \u2192 ${testYear}. ${progressText(progress)}
            </div>
            <div class="metrics-progress-bar"><span style="width:${percent}%;"></span></div>
            <div class="metrics-progress-percent">${percent.toFixed(0)}%</div>
            <div class="spinner" style="margin:auto;width:28px;height:28px;border:3px solid rgba(233,69,96,.3);border-top-color:#e94560;border-radius:50%;animation:spin .8s linear infinite;"></div>
        </div>
    `;
    if (!document.getElementById("spinnerKeyframes")) {
        const style = document.createElement("style");
        style.id = "spinnerKeyframes";
        style.textContent = "@keyframes spin{to{transform:rotate(360deg)}}";
        document.head.appendChild(style);
    }
}

function renderPendingEvaluationState(data) {
    const trainYear = data?.train_year ?? "?";
    const testYear = data?.test_year ?? "?";
    const progress = data?.progress || {};
    if (modelEvaluation && modelEvaluationIsStale) {
        renderMetricsProgressNotice(trainYear, testYear, progress);
    } else {
        renderMetricsPending(trainYear, testYear, progress);
    }
}

// Polls /api/model/evaluation every intervalMs until the result is ready.
function pollEvaluation(intervalMs = 2500) {
    if (evaluationPollTimer) clearTimeout(evaluationPollTimer);
    const poll = async () => {
        try {
            const res = await fetch("/api/model/evaluation");
            const data = await res.json();
            if (data.status === "ready" || data.status === "cached") {
                modelEvaluation = data;
                modelEvaluationIsStale = false;
                saveCachedModelEvaluation(data);
                renderMetrics(data);
                return;
            }
            if (data.status === "error") {
                if (modelEvaluation && modelEvaluationIsStale) {
                    renderMetricsProgressNotice(data.train_year ?? "?", data.test_year ?? "?", { status: "error" });
                } else {
                    renderMetricsError(data.error);
                }
                return;
            }
            renderPendingEvaluationState(data);
            evaluationPollTimer = setTimeout(poll, document.hidden ? intervalMs * 2 : intervalMs);
        } catch {
            evaluationPollTimer = setTimeout(poll, intervalMs * 2);
        }
    };
    evaluationPollTimer = setTimeout(poll, intervalMs);
}

async function loadStatsPage() {
    // Load summary and rows first — they are fast and unblock the whole page.
    // The model evaluation (backtest) is slow, so it is fetched separately:
    // the backend starts a background thread and returns {status:"pending"} immediately,
    // and the frontend polls until the result is ready.
    try {
        const [summaryRes, rowsRes] = await Promise.all([
            fetch("/api/summary"),
            fetch("/api/report/data"),
        ]);

        const summary = await summaryRes.json();
        const rowsPayload = await rowsRes.json();
        baseSummary = summary && typeof summary === "object" ? summary : {};

        allRows = Array.isArray(rowsPayload.rows) ? rowsPayload.rows : [];
        filteredRows = [...allRows];

        populateZoneFilter(allRows);
        renderDashboard(baseSummary, filteredRows, null);

        const cachedEvaluation = loadCachedModelEvaluation();
        if (cachedEvaluation) {
            modelEvaluation = cachedEvaluation;
            modelEvaluationIsStale = true;
            renderMetrics(cachedEvaluation, { stale: true });
        }

        // Kick off evaluation — returns instantly with pending or cached result
        try {
            const evalRes = await fetch("/api/model/evaluation");
            const evalData = await evalRes.json();
            if (evalData.status === "ready" || evalData.status === "cached") {
                modelEvaluation = evalData;
                modelEvaluationIsStale = false;
                saveCachedModelEvaluation(evalData);
                renderMetrics(evalData);
            } else {
                renderPendingEvaluationState(evalData);
                pollEvaluation();
            }
        } catch {
            renderPendingEvaluationState({ train_year: "?", test_year: "?", progress: {} });
            pollEvaluation();
        }
    } catch (error) {
        console.error("Error loading statistics:", error);
    }
}

// Recompone todas las secciones visibles a partir de una misma fuente de datos.
function renderDashboard(summary, rows, evaluation) {
    // Reutiliza la misma fuente de datos para todas las secciones visibles.
    const data = summary && typeof summary === "object" ? summary : {};
    populateComparisonYearSelects(rows);
    renderScopePill(data);
    renderKpis(data, rows);
    renderTopZones(data, rows);
    renderTemporalSections(data);
    renderCharts(data, rows);
    renderComparisons(data);
    renderMetrics(evaluation, { stale: modelEvaluationIsStale });
}

// Vuelve a pintar el tablero usando solo las filas filtradas actuales.
function rerenderFromCurrentRows() {
    // Vuelve a pintar las tarjetas y gráficas con los registros filtrados actuales.
    renderDashboard(baseSummary, filteredRows, modelEvaluation);
}

// Muestra de forma compacta el alcance temporal del resumen.
function renderScopePill(data) {
    // Muestra de forma compacta el alcance temporal del resumen.
    const target = document.getElementById("statsScopePill");
    if (!target) return;

    const years = Array.isArray(data.anios_disponibles) ? data.anios_disponibles : [];
    const scope = data.alcance_datos || buildScopeLabel(years);
    const cacheStatus = data?.cache_info?.status === "cached" ? "caché activa" : "datos frescos";
    target.textContent = `Alcance: ${scope} | ${cacheStatus}`;

    const headerNote = document.getElementById("statsHeaderNote");
    if (headerNote) {
        const startYear = years.length ? years[0] : "2024";
        const endYear = years.length ? years[years.length - 1] : "actualidad";
        headerNote.textContent = `Resumen total del dataset disponible desde ${startYear} hasta ${endYear}. Se actualiza cuando cambian los datos procesados o cuando se vuelve a generar el CSV limpio.`;
    }
}

// Construye una etiqueta simple cuando el backend no trae el alcance listo.
function buildScopeLabel(years) {
    if (!years || !years.length) return "General";
    if (years.length === 1) return `Año ${years[0]}`;
    return `General ${years[0]}-${years[years.length - 1]}`;
}

// Llena los selectores de comparación con los años presentes en el dataset.
function populateComparisonYearSelects(rows) {
    // Llena los selectores de comparación con todos los años presentes en el dataset.
    const sourceRows = allRows.length ? allRows : rows;
    const years = [...new Set(sourceRows.map((row) => Number(row.anio)).filter(Number.isFinite))].sort((a, b) => a - b);
    const selectA = document.getElementById("compareYearA");
    const selectB = document.getElementById("compareYearB");
    if (!selectA || !selectB || !years.length) return;

    const options = years.map((year) => `<option value="${year}">${year}</option>`).join("");
    const previousA = selectA.value && years.includes(Number(selectA.value)) ? selectA.value : String(years[0]);
    const previousB = selectB.value && years.includes(Number(selectB.value)) ? selectB.value : String(years[years.length - 1]);
    selectA.innerHTML = options;
    selectB.innerHTML = options;
    selectA.value = previousA;
    selectB.value = previousB;

    if (!selectA.dataset.bound) {
        selectA.addEventListener("change", rerenderFromCurrentRows);
        selectA.dataset.bound = "true";
    }
    if (!selectB.dataset.bound) {
        selectB.addEventListener("change", rerenderFromCurrentRows);
        selectB.dataset.bound = "true";
    }
}

// Obtiene un par de años de comparación coherente con los datos disponibles.
function getComparisonYearDefaults(data) {
    const byYear = data?.distribucion_anio || {};
    const years = Object.keys(byYear)
        .map((year) => Number(year))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    if (!years.length) return { yearA: 2024, yearB: 2025 };
    if (years.length === 1) return { yearA: years[0], yearB: years[0] };
    return { yearA: years[0], yearB: years[years.length - 1] };
}

// Carga el selector de zonas con los valores únicos del dataset.
function populateZoneFilter(rows) {
    const select = document.getElementById("zoneFilter");
    if (!select) return;

    const zones = [...new Set(rows.map((row) => row.zona).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.innerHTML = `
        <option value="__all__">Todas las zonas</option>
        ${zones.map((zone) => `<option value="${escapeHtml(zone)}">${escapeHtml(zone)}</option>`).join("")}
    `;
}

// Filtra las filas por zona y refresca el tablero.
function handleZoneFilterChange() {
    const select = document.getElementById("zoneFilter");
    if (!select) return;
    const zone = select.value;
    filteredRows = zone === "__all__" ? [...allRows] : allRows.filter((row) => row.zona === zone);
    rerenderFromCurrentRows();
}

// Devuelve el panel de estadísticas al estado general.
function resetFilters() {
    const select = document.getElementById("zoneFilter");
    if (select) select.value = "__all__";
    filteredRows = [...allRows];
    rerenderFromCurrentRows();
}

// Extrae los indicadores más útiles directamente desde las filas filtradas.
function buildRowHighlights(rows) {
    const source = Array.isArray(rows) ? rows : [];
    const total = source.length;
    const peakHour = formatPeakHourFromRows(source);
    const zoneCounts = {};
    const crimeTypes = new Set();

    source.forEach((row) => {
        const zone = String(row?.zona || "").trim();
        if (zone) zoneCounts[zone] = (zoneCounts[zone] || 0) + 1;

        const crime = String(row?.crimen || "").trim();
        if (crime) crimeTypes.add(crime);
    });

    const topZone = Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "Desconocida";

    return {
        total,
        peakHour,
        topZone,
        crimeTypes: crimeTypes.size,
        zoneCounts,
    };
}

// Pinta los indicadores clave de la página de estadísticas.
function renderKpis(data, rows) {
    const highlights = buildRowHighlights(rows);
    const total = highlights.total || data.total_incidentes || 0;
    const peakHour = highlights.peakHour || formatPeakHour(data, rows);
    const topZone = highlights.topZone || data.zona_mas_riesgosa || "Desconocida";
    const crimeTypes = highlights.crimeTypes || (data.distribucion_crimen ? Object.keys(data.distribucion_crimen).length : 0);
    const target = document.getElementById("statsKpis");
    if (!target) return;

    target.innerHTML = `
        <div class="kpi-card">
            <span class="kpi-label">Incidentes</span>
            <div class="kpi-value">${Number(total).toLocaleString()}</div>
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

// Ordena y dibuja las zonas con mayor presencia de incidentes.
function renderTopZones(data, rows) {
    const highlights = buildRowHighlights(rows);
    const topZones = Object.entries(highlights.zoneCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([zona, incidentes]) => ({ zona, incidentes }));
    const fallbackZones = Array.isArray(data.top_zonas) ? data.top_zonas : [];
    const zonesToRender = topZones.length ? topZones : fallbackZones;
    const target = document.getElementById("statsTopZones");
    if (!target) return;

    if (!zonesToRender.length) {
        target.innerHTML = '<div class="info-text">No hay zonas suficientes para mostrar ranking</div>';
        return;
    }

    target.innerHTML = zonesToRender.map((zone, index) => `
        <div class="predicted-zone">
            <b>#${index + 1} ${zone.zona}</b>
            <div class="risk-bar" style="width:${Math.max(20, 100 - index * 12)}%;"></div>
            <div>${zone.incidentes} incidentes</div>
        </div>
    `).join("");
}

// Actualiza los resúmenes temporales de fecha y hora.
function renderTemporalSections(data) {
    renderDateSummary(data);
    renderHourSummary(data);
}

// Dibuja el resumen por fecha según el modo seleccionado.
function renderDateSummary(data) {
    const mode = document.getElementById("dateViewFilter")?.value || "month";
    const target = document.getElementById("statsDateSummary");
    if (!target) return;

    const dayEntries = data.distribucion_dia ? Object.entries(data.distribucion_dia) : [];
    const yearEntries = data.distribucion_anio ? Object.entries(data.distribucion_anio) : [];
    const monthData = aggregateMonths(dayEntries);
    const monthEntries = Object.entries(monthData).sort((a, b) => a[0] - b[0]);

    if (mode === "year") {
        target.innerHTML = yearEntries
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([year, count]) => compactCard(String(year), count))
            .join("");
        return;
    }

    if (mode === "day") {
        const topDays = dayEntries
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8);
        target.innerHTML = topDays
            .map(([day, count]) => compactCard(shortDateLabel(day), count))
            .join("");
        return;
    }

    target.innerHTML = monthEntries
        .map(([month, count]) => compactCard(monthName(month), count))
        .join("");
}

// Dibuja el resumen por hora según el modo seleccionado.
function renderHourSummary(data) {
    const mode = document.getElementById("hourViewFilter")?.value || "summary";
    const target = document.getElementById("statsHourSummary");
    if (!target) return;

    const hourEntries = data.distribucion_hora ? Object.entries(data.distribucion_hora).sort((a, b) => Number(a[0]) - Number(b[0])) : [];
    if (mode === "full") {
        target.innerHTML = hourEntries.map(([hour, count]) => compactCard(`${String(hour).padStart(2, "0")}:00`, count)).join("");
        return;
    }

    const topHours = [...hourEntries].sort((a, b) => b[1] - a[1]).slice(0, 6);
    target.innerHTML = topHours.map(([hour, count]) => compactCard(`${String(hour).padStart(2, "0")}:00`, count)).join("");
}

// Construye las gráficas principales del reporte estadístico.
function renderCharts(data, rows) {
    const sourceRows = Array.isArray(rows) && rows.length ? rows : [];
    const hourData = sourceRows.length ? buildHourlySeriesFromRows(sourceRows) : (data.distribucion_hora || {});
    const crimeData = data.distribucion_crimen || {};
    const crimesByHour = sourceRows.length ? buildCrimeByHourFromRows(sourceRows) : (data.crimen_por_hora || {});
    const hourlySeries = Array.isArray(hourData.labels) && Array.isArray(hourData.values)
        ? hourData
        : buildHourlySeries(hourData);
    const hourLabels = hourlySeries.labels;
    const hourValues = hourlySeries.values;
    const hourCrimeLabels = buildHourlyCrimeLabels(crimesByHour);
    const labelStep = chooseHourLabelStep(hourLabels.length);
    const maxHourValue = hourValues.length ? Math.max(...hourValues) : 0;
    const yStep = chooseNiceStep(maxHourValue);
    const yMax = Math.max(yStep, Math.ceil((maxHourValue || 1) / yStep) * yStep);

    const hourCtx = document.getElementById("statsHourChart");
    if (hourCtx) {
        if (statsHourChart) statsHourChart.destroy();
        statsHourChart = new Chart(hourCtx.getContext("2d"), {
            type: "line",
            data: {
                labels: hourLabels,
                datasets: [{
                    label: "Incidentes",
                    data: hourValues,
                    borderColor: "#e94560",
                    backgroundColor: "rgba(233,69,96,0.12)",
                    borderWidth: 4,
                    fill: false,
                    tension: 0.38,
                    cubicInterpolationMode: "monotone",
                    borderCapStyle: "round",
                    borderJoinStyle: "round",
                    pointStyle: "circle",
                    pointRadius: (ctx) => (Number(ctx.raw || 0) > 0 ? 5 : 0),
                    pointHoverRadius: (ctx) => (Number(ctx.raw || 0) > 0 ? 7 : 0),
                    pointBackgroundColor: "#e94560",
                    pointBorderColor: getThemeTextColor(),
                    pointBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: getThemeTextColor() } },
                    tooltip: {
                        enabled: true,
                        callbacks: {
                            title(context) {
                                const index = context?.[0]?.dataIndex ?? 0;
                                return hourLabels[index] || "";
                            },
                            label(context) {
                                const index = context.dataIndex ?? 0;
                                const value = hourValues[index] || 0;
                                const crimeLabel = hourCrimeLabels[index] || "Sin dato";
                                return [`Incidentes: ${Math.round(value)}`, `Tipo probable: ${crimeLabel}`];
                            }
                        }
                    },
                    title: {
                        display: true,
                        text: "Tendencia por hora",
                        color: getThemeTextColor(),
                        font: { size: 18, weight: "bold" },
                        padding: { bottom: 12 }
                    }
                },
                layout: { padding: { top: 20, right: 10, left: 10, bottom: 0 } },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: getThemeTextColor(),
                            maxRotation: 0,
                            minRotation: 0,
                            autoSkip: false,
                            font: { size: 10, weight: "bold" },
                            callback: (value, index) => (index % labelStep === 0 ? hourLabels[index] : ""),
                            padding: 8
                        },
                        title: {
                            display: true,
                            text: "Hora del día",
                            color: getThemeTextColor(),
                            font: { size: 12, weight: "bold" }
                        }
                    },
                    y: {
                        beginAtZero: true,
                        min: 0,
                        max: yMax,
                        ticks: {
                            stepSize: yStep,
                            color: getThemeTextColor(),
                            font: { size: 11 },
                            callback: (value) => Number(value).toFixed(0)
                        },
                        grid: {
                            color: getThemeGridColor(),
                            lineWidth: 1.5
                        },
                        title: {
                            display: true,
                            text: "Número de incidentes",
                            color: getThemeTextColor(),
                            font: { size: 12, weight: "bold" }
                        }
                    }
                }
            }
        });
    }

    const crimeCtx = document.getElementById("statsCrimeChart");
    if (crimeCtx) {
        if (statsCrimeChart) statsCrimeChart.destroy();
        const crimeLabels = Object.keys(crimeData);
        const crimeValues = Object.values(crimeData);
        statsCrimeChart = new Chart(crimeCtx.getContext("2d"), {
            type: "doughnut",
            data: {
                labels: crimeLabels.length ? crimeLabels : ["Sin datos"],
                datasets: [{
                    data: crimeValues.length ? crimeValues : [1],
                    backgroundColor: ["#e94560", "#ff9f43", "#ffd93d", "#4caf50", "#4a90e2", "#9b59b6"]
                }]
            },
            options: {
                maintainAspectRatio: false,
                cutout: "58%",
                plugins: {
                    legend: { labels: { color: getThemeTextColor() } },
                    title: {
                        display: true,
                        text: "Distribución por delito",
                        color: getThemeTextColor(),
                        font: { size: 18, weight: "bold" },
                        padding: { bottom: 12 }
                    }
                }
            }
        });
    }
}

// Calcula una serie de 24 horas a partir de las filas filtradas.
function buildHourlySeriesFromRows(rows) {
    const counts = {};
    for (let hour = 0; hour < 24; hour += 1) {
        counts[hour] = 0;
    }

    (rows || []).forEach((row) => {
        const hour = Number(row?.hora);
        if (!Number.isFinite(hour)) return;
        const normalized = Math.max(0, Math.min(23, Math.round(hour)));
        counts[normalized] = (counts[normalized] || 0) + 1;
    });

    const labels = [];
    const values = [];
    for (let hour = 0; hour < 24; hour += 1) {
        labels.push(`${String(hour).padStart(2, "0")}:00`);
        values.push(counts[hour] || 0);
    }

    return { labels, values };
}

// Agrupa los delitos por hora para usarlos como apoyo visual en el gráfico.
function buildCrimeByHourFromRows(rows) {
    const bucket = {};
    (rows || []).forEach((row) => {
        const hour = Number(row?.hora);
        if (!Number.isFinite(hour)) return;
        const normalized = Math.max(0, Math.min(23, Math.round(hour)));
        const crime = String(row?.crimen || "Sin dato").trim() || "Sin dato";
        bucket[normalized] ||= {};
        bucket[normalized][crime] = (bucket[normalized][crime] || 0) + 1;
    });
    return bucket;
}

// Coordina la sección de comparación entre años y meses.
function renderComparisons(data) {
    renderYearSummary(data);
    renderYearChart(data);
    renderMonthChart(data);
}

// Resume en tarjetas la comparación entre dos años elegidos.
function renderYearSummary(data) {
    const target = document.getElementById("statsYearSummary");
    if (!target) return;

    const byYear = data.distribucion_anio || {};
    const selectA = document.getElementById("compareYearA");
    const selectB = document.getElementById("compareYearB");
    const defaults = getComparisonYearDefaults(data);
    const yearA = Number(selectA?.value || defaults.yearA);
    const yearB = Number(selectB?.value || defaults.yearB);
    const totalA = Number(byYear[yearA] || 0);
    const totalB = Number(byYear[yearB] || 0);
    const delta = totalB - totalA;
    const deltaLabel = delta === 0 ? "Sin cambio" : `${delta > 0 ? "+" : ""}${delta}`;

    target.innerHTML = [yearA, yearB].map((year) => `
        <div class="comparison-card">
            <span class="kpi-label">Año ${year}</span>
            <div class="kpi-value">${Number(byYear[year] || 0).toLocaleString()}</div>
            <span class="kpi-note">Incidentes detectados</span>
        </div>
    `).join("") + `
        <div class="comparison-card">
            <span class="kpi-label">Diferencia ${yearB} vs ${yearA}</span>
            <div class="kpi-value">${deltaLabel}</div>
            <span class="kpi-note">${delta > 0 ? "Aumentó" : delta < 0 ? "Disminuyó" : "Se mantuvo igual"}</span>
        </div>
    `;
}

// Dibuja la comparación anual en forma de barras.
function renderYearChart(data) {
    const byYear = data.distribucion_anio || {};
    const selectA = document.getElementById("compareYearA");
    const selectB = document.getElementById("compareYearB");
    const defaults = getComparisonYearDefaults(data);
    const yearA = Number(selectA?.value || defaults.yearA);
    const yearB = Number(selectB?.value || defaults.yearB);
    const years = [String(yearA), String(yearB)];
    const values = years.map((year) => Number(byYear[year] || byYear[Number(year)] || 0));

    const ctx = document.getElementById("statsYearChart");
    if (!ctx) return;
    if (statsYearChart) statsYearChart.destroy();

    statsYearChart = new Chart(ctx.getContext("2d"), {
        type: "bar",
        data: {
            labels: years,
            datasets: [{
                label: "Incidentes",
                data: values,
                backgroundColor: ["rgba(233,69,96,0.75)", "rgba(255,159,67,0.75)"],
                borderRadius: 12,
                borderSkipped: false,
            }],
        },
        options: {
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: getThemeTextColor() } },
                title: {
                    display: true,
                    text: `Comparación de incidentes por año: ${yearA} vs ${yearB}`,
                    color: getThemeTextColor(),
                    font: { size: 16, weight: "bold" },
                }
            },
            scales: {
                x: { ticks: { color: getThemeTextColor() } },
                y: { ticks: { color: getThemeTextColor() } },
            },
        },
    });
}

// Dibuja la comparación mensual entre los dos años seleccionados.
function renderMonthChart(data) {
    const byMonthYear = data.distribucion_mes_anio || {};
    const labels = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    const selectA = document.getElementById("compareYearA");
    const selectB = document.getElementById("compareYearB");
    const defaults = getComparisonYearDefaults(data);
    const yearA = Number(selectA?.value || defaults.yearA);
    const yearB = Number(selectB?.value || defaults.yearB);
    const yearSeriesA = buildMonthSeries(byMonthYear[yearA] || byMonthYear[String(yearA)] || {});
    const yearSeriesB = buildMonthSeries(byMonthYear[yearB] || byMonthYear[String(yearB)] || {});

    const ctx = document.getElementById("statsMonthChart");
    if (!ctx) return;
    if (statsMonthChart) statsMonthChart.destroy();

    statsMonthChart = new Chart(ctx.getContext("2d"), {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: String(yearA),
                    data: yearSeriesA,
                    backgroundColor: "rgba(233,69,96,0.55)",
                    borderRadius: 10,
                },
                {
                    label: String(yearB),
                    data: yearSeriesB,
                    backgroundColor: "rgba(255,159,67,0.55)",
                    borderRadius: 10,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: getThemeTextColor() } },
                title: {
                    display: true,
                    text: "Comparación mensual de los años",
                    color: getThemeTextColor(),
                    font: { size: 16, weight: "bold" },
                }
            },
            scales: {
                x: { ticks: { color: getThemeTextColor() } },
                y: { ticks: { color: getThemeTextColor() } },
            },
        },
    });
}

// Presenta las métricas del modelo con una lectura sencilla para el jurado.
function renderMetrics(evaluation, options = {}) {
    // Pinta las métricas del modelo y deja una explicación corta para cada una.
    if (!evaluation) return; // spinner already shown by renderMetricsPending
    const target = document.getElementById("modelMetrics");
    if (!target) return;

    const metrics = [
        ["Accuracy", evaluation?.accuracy],
        ["Precision", evaluation?.precision],
        ["Recall", evaluation?.recall],
        ["F1-score", evaluation?.f1_score],
        ["Hit Rate", evaluation?.hit_rate],
        ["PAI", evaluation?.pai],
    ];
    const evaluationDetail = evaluation?.evaluation_mode === "zone_day_hour"
        ? [
            `Backtest ${evaluation?.train_year || 2024} → ${evaluation?.test_year || 2025}`,
            `${evaluation?.zone_hotspots || evaluation?.top_n || 8} zonas críticas`,
            "día-hora",
        ].join(" | ")
        : [
            `Backtest ${evaluation?.train_year || 2024} → ${evaluation?.test_year || 2025}`,
            evaluation?.max_eval_hotspots ? `máx. ${evaluation.max_eval_hotspots} hotspots` : "",
            evaluation?.coverage_radius_cells !== undefined ? `radio ${evaluation.coverage_radius_cells} celda` : "",
        ].filter(Boolean).join(" | ");

    target.innerHTML = metrics.map(([label, value]) => `
        <div class="comparison-card metric-card" data-metric-card="true">
            <div class="metric-head">
                <span class="kpi-label">${label}</span>
                <button class="metric-more" type="button" aria-expanded="false">Más</button>
            </div>
            <div class="kpi-value">${formatMetric(value)}</div>
            <div class="metric-detail">
                <div><b>Qué mide:</b> ${metricPlainDescription(label)}</div>
                <div><b>Lectura:</b> ${metricQualityText(label, value)}</div>
                <div><b>Evaluación:</b> ${evaluationDetail}</div>
            </div>
        </div>
    `).join("");

    target.querySelectorAll("[data-metric-card='true']").forEach((card) => {
        const button = card.querySelector(".metric-more");
        if (!button) return;
        button.addEventListener("click", () => {
            const isOpen = card.dataset.open === "true";
            card.dataset.open = isOpen ? "false" : "true";
            button.setAttribute("aria-expanded", String(!isOpen));
        });
    });

    const legendTarget = document.getElementById("metricsLegend");
    if (legendTarget) {
        legendTarget.innerHTML = options.stale
            ? '<div class="info-text">Mostrando el último cálculo guardado mientras el backtest actual termina.</div>'
            : '<div class="info-text">Estas métricas muestran si el modelo encuentra bien las zonas de riesgo, qué tan confiables son sus alertas y qué tan eficiente resulta el área marcada como peligrosa.</div>';
    }
}

// Crea una tarjeta compacta reutilizable para los resúmenes.
function compactCard(title, value, note = "") {
    return `
        <div class="compact-card">
            <div class="compact-title">${escapeHtml(title)}</div>
            <div class="compact-value">${Number(value).toLocaleString()}</div>
            ${note ? `<span class="compact-note">${escapeHtml(note)}</span>` : ""}
        </div>
    `;
}

// Crea una tarjeta auxiliar para explicar cada métrica.
function metricLegendCard(label, description, note = "") {
    return `
        <div class="comparison-card">
            <span class="kpi-label">${escapeHtml(label)}</span>
            <div class="compact-note">${escapeHtml(description)}</div>
            ${note ? `<div class="compact-note">${escapeHtml(note)}</div>` : ""}
        </div>
    `;
}

// Devuelve una definición corta de cada métrica mostrada.
function metricPlainDescription(label) {
    const descriptions = {
        Accuracy: "Qué tanto acierta el modelo en general.",
        Precision: "De las zonas marcadas como riesgo alto, cuántas sí eran realmente críticas.",
        Recall: "De todas las zonas críticas reales, cuántas logró detectar.",
        "F1-score": "Balance entre precision y recall.",
        "Hit Rate": "Qué proporción de incidentes reales cayó dentro de las zonas predichas.",
        PAI: "Qué tan eficiente fue el área marcada como riesgo frente al resto del mapa.",
    };
    return descriptions[label] || "Métrica calculada por el backtest del modelo.";
}

// Suma los valores diarios para reconstruir el comportamiento mensual.
function aggregateMonths(dayEntries) {
    const totals = {};
    dayEntries.forEach(([day, count]) => {
        const parsed = new Date(day);
        if (Number.isNaN(parsed.getTime())) return;
        const month = parsed.getMonth() + 1;
        totals[month] = (totals[month] || 0) + Number(count || 0);
    });
    return totals;
}

// Convierte el número del mes en una abreviatura breve.
function monthName(month) {
    const names = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    return names[Number(month) - 1] || `Mes ${month}`;
}

// Formatea una fecha larga a una etiqueta más corta.
function shortDateLabel(dateText) {
    const parsed = new Date(dateText);
    if (Number.isNaN(parsed.getTime())) return dateText;
    return `${String(parsed.getDate()).padStart(2, "0")} ${monthName(parsed.getMonth() + 1)}`;
}

// Calcula la hora pico usando primero el dato del backend y luego las filas.
function formatPeakHour(data, rows) {
    const direct = Number(data?.pico_hora);
    if (Number.isFinite(direct)) {
        return `${String(direct).padStart(2, "0")}:00`;
    }

    const counts = {};
    (rows || []).forEach((row) => {
        const hour = Number(row.hora);
        if (!Number.isFinite(hour)) return;
        counts[hour] = (counts[hour] || 0) + 1;
    });

    const entries = Object.entries(counts);
    if (!entries.length) return "Sin datos";
    const peak = Number(entries.sort((a, b) => b[1] - a[1])[0][0]);
    return `${String(peak).padStart(2, "0")}:00`;
}

// Calcula la hora pico solo a partir de las filas filtradas.
function formatPeakHourFromRows(rows) {
    const counts = {};
    (rows || []).forEach((row) => {
        const hour = Number(row?.hora);
        if (!Number.isFinite(hour)) return;
        counts[hour] = (counts[hour] || 0) + 1;
    });

    const entries = Object.entries(counts);
    if (!entries.length) return "Sin datos";
    const peak = Number(entries.sort((a, b) => b[1] - a[1])[0][0]);
    return `${String(peak).padStart(2, "0")}:00`;
}

// Reordena los valores mensuales para que siempre salgan de enero a diciembre.
function buildMonthSeries(monthData) {
    const values = [];
    for (let month = 1; month <= 12; month += 1) {
        values.push(Number(monthData?.[month] || monthData?.[String(month)] || 0));
    }
    return values;
}

// Normaliza la serie horaria para que tenga 24 puntos comparables.
function buildHourlySeries(hourData) {
    const labels = [];
    const values = [];

    for (let hour = 0; hour < 24; hour += 1) {
        labels.push(`${String(hour).padStart(2, "0")}:00`);
        values.push(Math.round(Number(hourData?.[hour] || 0)));
    }

    return { labels, values };
}

// Identifica el delito dominante en cada hora para usarlo como etiqueta.
function buildHourlyCrimeLabels(crimesByHour) {
    const labels = [];

    for (let hour = 0; hour < 24; hour += 1) {
        const crimeBucket = crimesByHour[String(hour)] || crimesByHour[hour] || {};
        const topCrime = Object.entries(crimeBucket)
            .sort((a, b) => b[1] - a[1])
            .map(([crime]) => crime)[0] || "";
        labels.push(topCrime);
    }

    return labels;
}

// Convierte la hora a un valor seguro entre 0 y 23.
function normalizeHour(hour) {
    const value = Number(hour);
    if (Number.isFinite(value)) return Math.max(0, Math.min(23, Math.round(value)));
    return "NA";
}

// Convierte el mes a un valor válido usando una fecha de respaldo si hace falta.
function normalizeMonth(value, fallbackDate) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 12) return parsed;

    const fallback = new Date(String(fallbackDate || ""));
    const month = fallback.getMonth() + 1;
    if (Number.isFinite(month) && month >= 1 && month <= 12) return month;
    return 1;
}

// Elige un salto de eje Y legible para las gráficas.
function chooseNiceStep(maxValue) {
    if (maxValue <= 10) return 2;
    if (maxValue <= 25) return 5;
    if (maxValue <= 60) return 10;
    if (maxValue <= 120) return 20;
    return 50;
}

// Decide cuántas etiquetas mostrar sin saturar el eje X.
function chooseHourLabelStep(labelCount) {
    if (labelCount <= 8) return 1;
    if (labelCount <= 12) return 2;
    if (labelCount <= 24) return 3;
    return 4;
}

// Formatea un valor numérico para mostrarlo como porcentaje o decimal.
function formatMetric(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "Sin dato";
    const number = Number(value);
    if (number > 0 && number < 1) return `${(number * 100).toFixed(1)}%`;
    if (number <= 1) return number.toFixed(2);
    return number.toFixed(2);
}

// Traduce el valor de una métrica a una lectura cualitativa simple.
function metricQualityText(label, value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "No hay suficiente información para juzgar esta métrica.";

    if (label === "PAI") {
        if (numeric >= 2) return "Muy bueno: el área de riesgo es bastante eficiente.";
        if (numeric >= 1) return "Bueno: el área de riesgo aporta más que una selección uniforme.";
        return "Bajo: todavía hay margen para mejorar la eficiencia.";
    }

    if (numeric >= 0.9) return "Excelente: cerca de 90%/100% o más.";
    if (numeric >= 0.75) return "Buena: rendimiento sólido y útil.";
    if (numeric >= 0.6) return "Aceptable: funciona, pero todavía puede mejorar.";
    return "Baja: conviene revisar el modelo o los datos.";
}

// Exporta el subconjunto filtrado para revisarlo fuera del sistema.
function downloadCsvReport() {
    // Exporta el subconjunto filtrado para revisarlo fuera del sistema.
    if (!filteredRows.length) {
        return;
    }

    const headers = [
        ["id", "ID"],
        ["tipo", "Tipo"],
        ["fecha", "Fecha"],
        ["hora", "Hora"],
        ["provincia", "Provincia"],
        ["corregimiento", "Corregimiento"],
        ["latitud", "Latitud"],
        ["longitud", "Longitud"],
        ["arma_utilizada", "Arma utilizada"],
        ["locacion", "Locacion"],
        ["anio", "Anio"],
        ["mes", "Mes"],
        ["dia_semana", "Dia de semana"],
        ["source_file", "Fuente"],
    ];

    const rows = filteredRows
        .slice()
        .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || Number(a.hora || 0) - Number(b.hora || 0))
        .map((row) => headers.map(([key]) => csvCell(row[key])).join(","));

    const csv = [
        headers.map(([, label]) => label).join(","),
        ...rows,
    ].join("\n");

    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "reporte_estadisticas_siec.csv";
    a.click();
    URL.revokeObjectURL(url);
}

// Escapa cada celda antes de construir el archivo CSV.
function csvCell(value) {
    const text = value === null || value === undefined ? "" : String(value);
    const escaped = text.replaceAll('"', '""');
    return `"${escaped}"`;
}

// Escapa texto para insertarlo con seguridad en el HTML generado.
function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
