(function () {
  "use strict";

  /* ---------- Formatting ---------- */
  var fmtEUR = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
  var fmtKWH = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
  var fmtPct = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

  function num(el, fallback) {
    var v = parseFloat(el.value);
    return isFinite(v) && v >= 0 ? v : fallback;
  }

  /* ============================================================
     1) XLSX-Parsing (Mieterstrom-„Übersicht.xlsx", Tagesauflösung)
     Erwartete Kopfzeile (Zeile mit erstem Feld "Tag"):
       Tag, Name, Ertrag, Verbrauch, Eigenverbrauch, Netzbezug,
       Einspeisung, [Beladung, Entladung, ...]
     Jeder Tag hat eine Gesamtzeile (Spalte "Tag" gefüllt) gefolgt von
     Unterzähler-Zeilen (Spalte "Tag" leer) — nur die Gesamtzeile wird
     ausgewertet. Die Datei endet mit Fußzeilen ("Summen", "Abweichungen …"),
     erkennbar daran, dass Spalte "Tag" keinen gültigen dd.mm.yyyy-Wert mehr
     enthält — dort bricht das Parsing ab.

     Die Spalten "Netzbezug"/"Einspeisung" werden nur zur Formaterkennung
     geprüft, ihre Werte aber NICHT übernommen: sie sind rechnerisch aus den
     Tagessummen zurückgerechnet (Eigenverbrauch = Ertrag − Einspeisung,
     Netzbezug = Verbrauch − Eigenverbrauch) und unterschätzen echte
     Lastverschiebung zwischen Tag und Nacht (siehe Vergleich mit dem echten
     Live-Monitoring). Stattdessen liefert diese Funktion nur Ertrag/Verbrauch;
     Netzbezug/Einspeisung werden in buildDayNightSeries() aus einem
     geschätzten Nachtanteil neu hergeleitet.
     ============================================================ */
  var DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

  function parseDayCell(v) {
    if (typeof v === "string") {
      var m = DATE_RE.exec(v.trim());
      if (!m) return null;
      return { y: parseInt(m[3], 10), mo: parseInt(m[2], 10), d: parseInt(m[1], 10) };
    }
    if (typeof v === "number" && isFinite(v)) {
      // Excel-Seriendatum (Fallback, falls Zelle als Zahl statt Text vorliegt)
      var dt = new Date(Math.round((v - 25569) * 86400 * 1000));
      if (isNaN(dt.getTime())) return null;
      return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
    }
    return null;
  }

  function dayKey(day) { return day.y * 10000 + day.mo * 100 + day.d; }
  function dayLabel(day) {
    return (day.d < 10 ? "0" : "") + day.d + "." + (day.mo < 10 ? "0" : "") + day.mo + "." + day.y;
  }

  function parseWorkbook(arrayBuffer) {
    var wb = XLSX.read(arrayBuffer, { type: "array" });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

    var anlage = null, jahr = null, headerIdx = -1, header = null;
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var r = rows[i];
      if (!r || r.length === 0) continue;
      if (r[0] === "Anlage") anlage = r[1];
      if (r[0] === "Jahr") jahr = r[1];
      if (r[0] === "Tag") { headerIdx = i; header = r; break; }
    }
    if (headerIdx === -1) {
      throw new Error("Kein bekanntes Format erkannt: Kopfzeile mit „Tag“ wurde nicht gefunden.");
    }

    var colIdx = {};
    for (var c = 0; c < header.length; c++) {
      if (header[c] != null) colIdx[String(header[c]).trim()] = c;
    }
    var required = ["Ertrag", "Verbrauch", "Netzbezug", "Einspeisung"];
    var missing = required.filter(function (k) { return !(k in colIdx); });
    if (missing.length) {
      throw new Error("Erforderliche Spalten fehlen in der Kopfzeile: " + missing.join(", ") + ".");
    }
    var hasBattery = ("Beladung" in colIdx) && ("Entladung" in colIdx);

    var days = [];
    for (var j = headerIdx + 1; j < rows.length; j++) {
      var row = rows[j];
      if (!row || row[0] == null || row[0] === "") continue; // Unterzähler-/Leerzeile
      var d = parseDayCell(row[0]);
      if (!d) break; // Fußzeile erreicht (z. B. "Summen")

      var ertrag = Number(row[colIdx["Ertrag"]]) || 0;
      var verbrauch = Number(row[colIdx["Verbrauch"]]) || 0;

      days.push({
        key: dayKey(d),
        label: dayLabel(d),
        ertrag: ertrag,
        verbrauch: verbrauch
      });
    }
    if (days.length === 0) {
      throw new Error("Keine Tageszeilen im erwarteten Format (dd.mm.yyyy) gefunden.");
    }
    days.sort(function (a, b) { return a.key - b.key; });

    return { anlage: anlage, jahr: jahr, hasBattery: hasBattery, days: days };
  }

  /* ============================================================
     1b) Tag/Nacht-Rekonstruktion von Netzbezug/Einspeisung
     Nachtbedarf = Nachtanteil % × Tagesverbrauch (muss zwingend aus Speicher
     oder Netz kommen, da nachts kein PV-Ertrag). Der Rest ist Tagesbedarf,
     der zuerst aus dem PV-Ertrag desselben Tages gedeckt wird; ein Fehlbetrag
     tagsüber ist zusätzlicher Netzbezug, ein Überschuss ist speicherbare
     Einspeisung.

     Bei aktivierter Klimaanlage wird der Verbrauch zusätzlich in zwei
     Anteile zerlegt, statt einen gemittelten Nachtanteil zu verwenden:
     Grundlast (inkl. Wärmepumpe/Warmwasser — läuft unabhängig von der Klima-
     Frage weiter, eigener Nachtanteil) und Klima-Mehrverbrauch (der Teil, der
     über der Grundlast liegt — angenähert als 20.-Perzentil des Jahres-
     verbrauchs, da Klimaanlagen nur an warmen/sonnigen Tagen zusätzlich
     laufen und fast ausschließlich tagsüber, eigener niedriger Nachtanteil).
     ============================================================ */
  function percentile(sortedArr, p) {
    if (!sortedArr.length) return 0;
    var idx = (p / 100) * (sortedArr.length - 1);
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
  }

  function buildDayNightSeries(rawDays, nachtanteilBasisFrac, klimaActive, nachtanteilKlimaFrac) {
    var grundlastRef = null;
    if (klimaActive) {
      // Tage mit Verbrauch = 0 (Datenlücken/Wochenend-Nullungen in der xlsx)
      // ausschließen, sonst zieht das Perzentil auf 0 und die Grundlast
      // verschwindet komplett aus dem Modell.
      var nonZero = rawDays.map(function (d) { return d.verbrauch; }).filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
      grundlastRef = percentile(nonZero, 20);
    }
    return rawDays.map(function (d) {
      var grundlast = klimaActive ? Math.min(d.verbrauch, grundlastRef) : d.verbrauch;
      var klimaAnteil = klimaActive ? Math.max(0, d.verbrauch - grundlastRef) : 0;
      var nachtbedarf = nachtanteilBasisFrac * grundlast + nachtanteilKlimaFrac * klimaAnteil;
      var tagsBedarf = d.verbrauch - nachtbedarf;
      var tagesDefizit = Math.max(0, tagsBedarf - d.ertrag);
      var ueberschuss = Math.max(0, d.ertrag - tagsBedarf);
      return {
        key: d.key, label: d.label, ertrag: d.ertrag, verbrauch: d.verbrauch,
        netzbezug0: nachtbedarf + tagesDefizit, einspeisung0: ueberschuss
      };
    });
  }

  /* ============================================================
     2) Klassisch-Simulation: Tages-Bilanz-Speicher, reiner PV-Betrieb
     ============================================================ */
  function simulateCapacity(days, capacityKwh, eta, withDetail) {
    var soc = 0, netzbezugMit = 0, einspeisungMit = 0, throughput = 0;
    var detail = withDetail ? [] : null;
    for (var i = 0; i < days.length; i++) {
      var surplus = days[i].einspeisung0;
      var deficit = days[i].netzbezug0;
      var room = capacityKwh - soc;
      var chargeIn = Math.min(surplus, room > 0 ? room : 0);
      soc += chargeIn * eta;
      throughput += chargeIn;
      einspeisungMit += (surplus - chargeIn);
      var socVorEntladung = soc;
      var served = Math.min(deficit, soc);
      soc -= served;
      var remaining = deficit - served;
      netzbezugMit += remaining;
      if (withDetail) {
        detail.push({
          label: days[i].label, key: days[i].key,
          ueberschuss: surplus, bedarf: deficit, sozVorEntladung: socVorEntladung,
          gedeckt: served, rest: remaining
        });
      }
    }
    return { netzbezugMit: netzbezugMit, einspeisungMit: einspeisungMit, throughput: throughput, detail: detail };
  }

  function buildKlassischCurve(days, capacities, eta) {
    return capacities.map(function (c) {
      var r = simulateCapacity(days, c, eta);
      return { c: c, netzbezugMit: r.netzbezugMit, einspeisungMit: r.einspeisungMit, vollzyklen: c > 0 ? r.throughput / c : 0 };
    });
  }

  /* ============================================================
     3) MiSpeL-Arbitrage-Schicht (reale Day-Ahead-Preise, wie kompass.js)
     Sortierung je Preistag wird einmal vorab berechnet und über alle
     Kapazitäten wiederverwendet (Performance).
     ============================================================ */
  function precomputeSortedPriceDays(data) {
    if (!data || !data.prices || !data.prices.length) return null;
    var stepMin = data.step_minutes || 15;
    var perDayCount = Math.round((24 * 60) / stepMin);
    var nDays = Math.floor(data.prices.length / perDayCount);
    if (nDays < 1) return null;
    var out = [];
    for (var d = 0; d < nDays; d++) {
      var day = data.prices.slice(d * perDayCount, (d + 1) * perDayCount);
      out.push({
        asc: day.slice().sort(function (a, b) { return a - b; }),
        desc: day.slice().sort(function (a, b) { return b - a; })
      });
    }
    return { days: out, stepMin: stepMin, nDays: nDays };
  }

  function arbitrageForCapacity(pre, capacityKwh, leistungKw, ladestundenVerfuegbar, eff) {
    if (!pre || capacityKwh <= 0 || leistungKw <= 0) return { rateCt: 0, volumeKwhYear: 0 };
    var hoursPerDay = ladestundenVerfuegbar / 365;
    var dailyVol = Math.min(capacityKwh, leistungKw * hoursPerDay);
    if (dailyVol <= 0) return { rateCt: 0, volumeKwhYear: 0 };
    var maxPerSlot = leistungKw * (pre.stepMin / 60);

    function allocate(sorted, vol) {
      var remaining = vol, cost = 0, energy = 0;
      for (var i = 0; i < sorted.length && remaining > 0; i++) {
        var take = Math.min(maxPerSlot, remaining);
        cost += (sorted[i] * take) / 1000;
        energy += take;
        remaining -= take;
      }
      return { cost: cost, energy: energy };
    }

    var totalChargeCost = 0, totalChargeEnergy = 0, totalSellValue = 0;
    for (var d = 0; d < pre.nDays; d++) {
      var c = allocate(pre.days[d].asc, dailyVol);
      var s = allocate(pre.days[d].desc, dailyVol * eff);
      totalChargeCost += c.cost;
      totalChargeEnergy += c.energy;
      totalSellValue += s.cost;
    }
    if (totalChargeEnergy <= 0) return { rateCt: 0, volumeKwhYear: 0 };
    return {
      rateCt: ((totalSellValue - totalChargeCost) / totalChargeEnergy) * 100,
      volumeKwhYear: (totalChargeEnergy * 365) / pre.nDays
    };
  }

  /* ============================================================
     3b) Reale Spotmarktpreise: Ø Tag-/Nacht-Preis (Option, nur Anzeige)
     Klassifiziert jede 15-Minuten-Preiszelle nach lokaler Uhrzeit
     (Europe/Berlin, DST-sicher über Intl) in "Tag" (07–19 Uhr, PV-Fenster)
     oder "Nacht" (19–07 Uhr).
     ============================================================ */
  function classifyPriceDayNight(data) {
    if (!data || !data.prices || !data.prices.length || !data.start_utc) return null;
    var stepMin = data.step_minutes || 15;
    var start = new Date(data.start_utc).getTime();
    var fmt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" });
    var sumDay = 0, nDay = 0, sumNight = 0, nNight = 0;
    for (var i = 0; i < data.prices.length; i++) {
      var t = new Date(start + i * stepMin * 60000);
      var hour = parseInt(fmt.format(t), 10);
      var isDay = hour >= 7 && hour < 19;
      var p = data.prices[i];
      if (isDay) { sumDay += p; nDay++; } else { sumNight += p; nNight++; }
    }
    return {
      avgDayCt: nDay ? (sumDay / nDay) / 10 : 0,
      avgNightCt: nNight ? (sumNight / nNight) / 10 : 0,
      nDays: data.n_days || Math.floor(data.prices.length / (Math.round((24 * 60) / stepMin)))
    };
  }

  /* Ø günstigster/teuerster Preis pro Tag (Mittel der Tages-Minima/-Maxima) —
     zeigt, wie tief die billigste Viertelstunde eines Tages im Schnitt fällt. */
  function computeAvgDailyMinMax(data) {
    if (!data || !data.prices || !data.prices.length) return null;
    var stepMin = data.step_minutes || 15;
    var perDayCount = Math.round((24 * 60) / stepMin);
    var nDays = Math.floor(data.prices.length / perDayCount);
    if (nDays < 1) return null;
    var sumMin = 0, sumMax = 0;
    for (var d = 0; d < nDays; d++) {
      var day = data.prices.slice(d * perDayCount, (d + 1) * perDayCount);
      sumMin += Math.min.apply(null, day);
      sumMax += Math.max.apply(null, day);
    }
    return { avgMinCt: (sumMin / nDays) / 10, avgMaxCt: (sumMax / nDays) / 10, nDays: nDays };
  }

  function priceDataPeriodLabel(data) {
    if (!data || !data.start_utc) return "";
    var start = new Date(data.start_utc);
    var end = new Date(start.getTime() + (data.n_days || 0) * 86400000);
    var f = function (dt) { return dt.toLocaleDateString("de-DE", { month: "short", year: "numeric" }); };
    return f(start) + " – " + f(end);
  }

  /* ============================================================
     4) Empfehlung: kleinste Kapazität, die schon "Schwelle" % des bei
     der größten simulierten Kapazität erreichbaren Nutzens liefert.
     ============================================================ */
  function findRecommended(curve, thresholdFrac) {
    var maxVal = curve[curve.length - 1].value;
    if (maxVal <= 0) return curve[0];
    for (var i = 0; i < curve.length; i++) {
      if (curve[i].value >= thresholdFrac * maxVal) return curve[i];
    }
    return curve[curve.length - 1];
  }

  /* ============================================================
     5) UI wiring
     ============================================================ */
  var $fileInput = document.getElementById("file-input");
  var $uploadDrop = document.getElementById("upload-drop");
  var $uploadStatus = document.getElementById("upload-status");
  var $uploadError = document.getElementById("upload-error");
  var $results = document.getElementById("results");

  var $anlageTitel = document.getElementById("anlage-titel");
  var $anlageSub = document.getElementById("anlage-sub");
  var $ctxVerbrauch = document.getElementById("ctx-verbrauch");
  var $ctxErtrag = document.getElementById("ctx-ertrag");
  var $ctxZeitraum = document.getElementById("ctx-zeitraum");
  var $ctxSpeicherErkannt = document.getElementById("ctx-speicher-erkannt");
  var $noteHochrechnung = document.getElementById("note-hochrechnung");

  var $eta = document.getElementById("in-eta");
  var $schwelle = document.getElementById("in-schwelle");
  var $strompreis = document.getElementById("in-strompreis");
  var $leistung = document.getElementById("in-leistung");
  var $ladestunden = document.getElementById("in-ladestunden");

  var $rvKlassisch = document.getElementById("rv-klassisch");
  var $rnKlassisch = document.getElementById("rn-klassisch");
  var $rvMispel = document.getElementById("rv-mispel");
  var $rnMispel = document.getElementById("rn-mispel");
  var $tableBody = document.getElementById("table-body");
  var $toggleTable = document.getElementById("toggle-table");
  var $tableWrap = document.getElementById("table-wrap");

  var $testgroesse = document.getElementById("in-testgroesse");
  var $testgroesseSlider = document.getElementById("in-testgroesse-slider");
  var $ctxTageUnterdeckung = document.getElementById("ctx-tage-unterdeckung");
  var $ctxUnterdeckungMax = document.getElementById("ctx-unterdeckung-max");
  var $ctxUnterdeckungSumme = document.getElementById("ctx-unterdeckung-summe");
  var $unterdeckungSub = document.getElementById("unterdeckung-sub");
  var $tableBodyUnterdeckung = document.getElementById("table-body-unterdeckung");
  var testgroesseTouched = false;

  var $toggleTableUnterdeckung = document.getElementById("toggle-table-unterdeckung");
  var $unterdeckungTableWrap = document.getElementById("unterdeckung-table-wrap");
  $toggleTableUnterdeckung.addEventListener("click", function () {
    var showing = $unterdeckungTableWrap.style.display !== "none";
    $unterdeckungTableWrap.style.display = showing ? "none" : "block";
    $toggleTableUnterdeckung.setAttribute("aria-expanded", String(!showing));
    $toggleTableUnterdeckung.textContent = showing ? "Als Tabelle anzeigen" : "Tabelle ausblenden";
  });

  var $wpJa = document.getElementById("wp-ja"), $wpNein = document.getElementById("wp-nein");
  var $klimaJa = document.getElementById("klima-ja"), $klimaNein = document.getElementById("klima-nein");
  var $nachtanteil = document.getElementById("in-nachtanteil");
  var $nachtanteilSlider = document.getElementById("in-nachtanteil-slider");
  var nachtanteilTouched = false;

  var $btnSpotpreise = document.getElementById("btn-spotpreise");
  var $spotpreiseBody = document.getElementById("spotpreise-body");
  var $ctxPreisTag = document.getElementById("ctx-preis-tag");
  var $ctxPreisNacht = document.getElementById("ctx-preis-nacht");
  var $ctxPreisZeitraum = document.getElementById("ctx-preis-zeitraum");
  var $spotpreiseHinweis = document.getElementById("spotpreise-hinweis");

  var currentParsed = null; // { anlage, jahr, hasBattery, days } — days: nur Ertrag/Verbrauch
  var simDays = null; // days nach Tag/Nacht-Rekonstruktion (aktuelle Annahmen)
  var pricePre = precomputeSortedPriceDays(window.MISPEL_PREISDATEN);
  var priceDayNight = classifyPriceDayNight(window.MISPEL_PREISDATEN);
  var priceMinMax = computeAvgDailyMinMax(window.MISPEL_PREISDATEN);

  (function initPreisMinMaxInfo() {
    var $el = document.getElementById("preis-min-max-info");
    if (!$el) return;
    if (!priceMinMax) { $el.textContent = "Reale Preisdaten nicht verfügbar."; return; }
    $el.innerHTML = "Ø günstigster Preis/Tag: <strong>" + priceMinMax.avgMinCt.toFixed(1) + " ct/kWh</strong> · " +
      "Ø teuerster Preis/Tag: <strong>" + priceMinMax.avgMaxCt.toFixed(1) + " ct/kWh</strong> " +
      "(Day-Ahead DE-LU, " + priceDataPeriodLabel(window.MISPEL_PREISDATEN) + ", Quelle: energy-charts.info)";
  })();

  var CAPACITIES = [];
  for (var cc = 0; cc <= 300; cc++) CAPACITIES.push(cc);

  var $klimaNachtanteilWrap = document.getElementById("klima-nachtanteil-wrap");
  var $nachtanteilKlima = document.getElementById("in-nachtanteil-klima");
  var $nachtanteilKlimaSlider = document.getElementById("in-nachtanteil-klima-slider");

  function setNachtanteilDefault() {
    // Klima verändert den Basis-Nachtanteil (Grundlast/Wärmepumpe) nicht mehr —
    // die läuft unabhängig davon weiter. Nur Wärmepumpe bestimmt die Basis.
    if (nachtanteilTouched) return;
    var wp = $wpJa.getAttribute("aria-pressed") === "true";
    var v = wp ? 42 : 30;
    $nachtanteil.value = v;
    $nachtanteilSlider.value = v;
  }
  function setYesNo(btnJa, btnNein, ja) {
    btnJa.setAttribute("aria-pressed", String(ja));
    btnNein.setAttribute("aria-pressed", String(!ja));
  }
  function updateKlimaFieldVisibility() {
    var klima = $klimaJa.getAttribute("aria-pressed") === "true";
    $klimaNachtanteilWrap.hidden = !klima;
  }
  $wpJa.addEventListener("click", function () { setYesNo($wpJa, $wpNein, true); setNachtanteilDefault(); if (currentParsed) renderAll(); });
  $wpNein.addEventListener("click", function () { setYesNo($wpJa, $wpNein, false); setNachtanteilDefault(); if (currentParsed) renderAll(); });
  $klimaJa.addEventListener("click", function () { setYesNo($klimaJa, $klimaNein, true); updateKlimaFieldVisibility(); if (currentParsed) renderAll(); });
  $klimaNein.addEventListener("click", function () { setYesNo($klimaJa, $klimaNein, false); updateKlimaFieldVisibility(); if (currentParsed) renderAll(); });
  updateKlimaFieldVisibility();

  $nachtanteilSlider.addEventListener("input", function () {
    nachtanteilTouched = true;
    $nachtanteil.value = $nachtanteilSlider.value;
    if (currentParsed) renderAll();
  });
  $nachtanteil.addEventListener("input", function () {
    nachtanteilTouched = true;
    var v = parseFloat($nachtanteil.value);
    if (isFinite(v)) $nachtanteilSlider.value = v;
    if (currentParsed) renderAll();
  });
  $nachtanteilKlimaSlider.addEventListener("input", function () {
    $nachtanteilKlima.value = $nachtanteilKlimaSlider.value;
    if (currentParsed) renderAll();
  });
  $nachtanteilKlima.addEventListener("input", function () {
    var v = parseFloat($nachtanteilKlima.value);
    if (isFinite(v)) $nachtanteilKlimaSlider.value = v;
    if (currentParsed) renderAll();
  });

  $btnSpotpreise.addEventListener("click", function () {
    var showing = !$spotpreiseBody.hidden;
    $spotpreiseBody.hidden = showing;
    $btnSpotpreise.setAttribute("aria-expanded", String(!showing));
    $btnSpotpreise.textContent = showing ? "Spotmarktpreise anzeigen" : "Spotmarktpreise ausblenden";
    if (!showing) renderSpotpreise();
  });

  function showError(msg) {
    $uploadError.textContent = msg;
    $uploadError.hidden = false;
    $uploadStatus.textContent = "";
    $uploadStatus.classList.remove("active");
    $results.hidden = true;
  }

  function handleFile(file) {
    if (!file) return;
    $uploadError.hidden = true;
    $uploadStatus.textContent = "Lese " + file.name + " …";
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var parsed = parseWorkbook(e.target.result);
        currentParsed = parsed;
        $uploadStatus.textContent = "Geladen: " + file.name + " (" + parsed.days.length + " Tage)";
        $uploadStatus.classList.add("active");
        renderAll();
      } catch (err) {
        showError(err.message || String(err));
      }
    };
    reader.onerror = function () { showError("Datei konnte nicht gelesen werden."); };
    reader.readAsArrayBuffer(file);
  }

  $fileInput.addEventListener("change", function () { handleFile($fileInput.files[0]); });
  ["dragover"].forEach(function (evt) {
    $uploadDrop.addEventListener(evt, function (e) { e.preventDefault(); $uploadDrop.classList.add("dragover"); });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    $uploadDrop.addEventListener(evt, function (e) { e.preventDefault(); $uploadDrop.classList.remove("dragover"); });
  });
  $uploadDrop.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  [$eta, $schwelle, $strompreis, $ladestunden].forEach(function (el) {
    el.addEventListener("input", function () { if (currentParsed) renderAll(); });
  });

  var leistungTouched = false;
  $leistung.addEventListener("input", function () { leistungTouched = true; if (currentParsed) renderAll(); });

  /* Ladeleistung Netzladung MiSpeL aus PV-Spitzenleistung vorschlagen:
     Spitzenleistung ≈ höchster Tagesertrag im Datensatz ÷ 5 Volllaststunden
     (Süddeutschland-Faustregel). Wechselrichter-Schrittgröße 15 oder 20 kW
     (>20 kW Spitzenleistung → Schrittgröße 20, sonst 15), Leistung steigt in
     dieser Schrittgröße, bis die Spitzenleistung abgedeckt ist (Aufrunden auf
     volle Schritte, nicht fix verdoppelt). */
  function suggestLeistung(rawDays) {
    var maxErtrag = rawDays.reduce(function (m, d) { return Math.max(m, d.ertrag); }, 0);
    var peakKw = maxErtrag / 5;
    var step = peakKw > 20 ? 20 : 15;
    var n = Math.max(1, Math.ceil(peakKw / step));
    return { value: n * step, peakKw: peakKw, step: step, n: n };
  }

  $testgroesseSlider.addEventListener("input", function () {
    testgroesseTouched = true;
    $testgroesse.value = $testgroesseSlider.value;
    if (currentParsed) renderUnterdeckung();
  });
  $testgroesse.addEventListener("input", function () {
    testgroesseTouched = true;
    var v = parseFloat($testgroesse.value);
    if (isFinite(v)) $testgroesseSlider.value = v;
    if (currentParsed) renderUnterdeckung();
  });
  $eta.addEventListener("input", function () { if (currentParsed) renderUnterdeckung(); });

  /* ---------- Chart ---------- */
  var chartState = null; // { capacities, klassischEur, mispelEur, autarkie, recK, recM }

  function renderChart(state) {
    var svg = document.getElementById("linechart");
    var W = 880, H = 340, padL = 56, padR = 16, padT = 16, padB = 32;
    var innerW = W - padL - padR, innerH = H - padT - padB;

    var maxVal = Math.max(state.mispelEur[state.mispelEur.length - 1], state.klassischEur[state.klassischEur.length - 1], 1);
    var maxY = Math.ceil(maxVal * 1.12 / 50) * 50;
    var maxC = state.capacities[state.capacities.length - 1];

    function x(c) { return padL + (c / maxC) * innerW; }
    function y(v) { return padT + innerH - (v / maxY) * innerH; }

    function pathFor(values) {
      var d = "";
      for (var i = 0; i < state.capacities.length; i++) {
        d += (i === 0 ? "M" : "L") + x(state.capacities[i]).toFixed(1) + "," + y(values[i]).toFixed(1) + " ";
      }
      return d;
    }

    var svgns = "http://www.w3.org/2000/svg";
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    function el(tag, attrs) {
      var n = document.createElementNS(svgns, tag);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }

    // Gitterlinien + Y-Achsenbeschriftung
    var steps = 4;
    for (var s = 0; s <= steps; s++) {
      var v = (maxY / steps) * s;
      var gy = y(v);
      svg.appendChild(el("line", { x1: padL, x2: W - padR, y1: gy, y2: gy, class: "lc-grid-line" }));
      var lab = el("text", { x: padL - 8, y: gy + 4, class: "lc-axis-label", "text-anchor": "end" });
      lab.textContent = fmtEUR.format(v) + " €";
      svg.appendChild(lab);
    }
    // X-Achse
    svg.appendChild(el("line", { x1: padL, x2: W - padR, y1: padT + innerH, y2: padT + innerH, class: "lc-axis-line" }));
    [0, 50, 100, 150, 200, 250, 300].forEach(function (c) {
      if (c > maxC) return;
      var lab = el("text", { x: x(c), y: padT + innerH + 20, class: "lc-axis-label", "text-anchor": "middle" });
      lab.textContent = c + " kWh";
      svg.appendChild(lab);
    });

    svg.appendChild(el("path", { d: pathFor(state.klassischEur), class: "lc-line klassisch", stroke: "var(--chart-pv)" }));
    svg.appendChild(el("path", { d: pathFor(state.mispelEur), class: "lc-line mispel", stroke: "var(--chart-market)" }));

    function marker(rec, values, color, labelText, dy) {
      var idx = state.capacities.indexOf(rec.c);
      var mx = x(rec.c), my = y(values[idx]);
      svg.appendChild(el("line", { x1: mx, x2: mx, y1: padT, y2: padT + innerH, class: "lc-marker-line", stroke: color }));
      svg.appendChild(el("circle", { cx: mx, cy: my, r: 5, fill: color, class: "lc-marker-dot" }));
      var lab = el("text", { x: mx, y: padT + dy, class: "lc-marker-label", fill: color, "text-anchor": mx > innerW * 0.8 ? "end" : "middle" });
      lab.textContent = labelText + ": " + rec.c + " kWh";
      svg.appendChild(lab);
    }
    marker(state.recK, state.klassischEur, "var(--chart-pv)", "Klassisch", 14);
    marker(state.recM, state.mispelEur, "var(--chart-market)", "MiSpeL", 30);

    // Crosshair + Tooltip (Hover)
    var hit = el("rect", { x: padL, y: padT, width: innerW, height: innerH, class: "lc-hit-area" });
    var crosshair = el("line", { x1: 0, x2: 0, y1: padT, y2: padT + innerH, class: "lc-crosshair" });
    crosshair.style.display = "none";
    svg.appendChild(crosshair);
    svg.appendChild(hit);

    var $tooltip = document.getElementById("lc-tooltip");
    hit.addEventListener("mousemove", function (e) {
      var rect = svg.getBoundingClientRect();
      var px = (e.clientX - rect.left) * (W / rect.width);
      var c = Math.round(((px - padL) / innerW) * maxC);
      c = Math.max(0, Math.min(maxC, c));
      var idx = state.capacities.indexOf(c);
      if (idx === -1) return;
      crosshair.style.display = "block";
      crosshair.setAttribute("x1", x(c)); crosshair.setAttribute("x2", x(c));

      $tooltip.hidden = false;
      $tooltip.style.left = ((x(c) / W) * rect.width) + "px";
      $tooltip.innerHTML =
        '<div class="tt-title">' + c + ' kWh</div>' +
        '<div class="tt-row"><span class="tt-swatch" style="background:var(--chart-pv)"></span>Klassisch: ' + fmtEUR.format(state.klassischEur[idx]) + ' €/Jahr</div>' +
        '<div class="tt-row"><span class="tt-swatch" style="background:var(--chart-market)"></span>MiSpeL: ' + fmtEUR.format(state.mispelEur[idx]) + ' €/Jahr</div>' +
        '<div class="tt-row" style="color:var(--text-muted)">Autarkiegrad: ' + fmtPct.format(state.autarkie[idx] * 100) + ' %</div>';
    });
    hit.addEventListener("mouseleave", function () { crosshair.style.display = "none"; $tooltip.hidden = true; });
  }

  function renderTable(state) {
    var rows = "";
    [0, 5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 250, 300].forEach(function (c) {
      if (c > state.capacities[state.capacities.length - 1]) return;
      var idx = state.capacities.indexOf(c);
      rows += "<tr><td>" + c + "</td><td>" + fmtPct.format(state.autarkie[idx] * 100) + " %</td><td>" +
        fmtEUR.format(state.klassischEur[idx]) + "</td><td>" + fmtEUR.format(state.mispelEur[idx]) + "</td></tr>";
    });
    $tableBody.innerHTML = rows;
  }

  $toggleTable.addEventListener("click", function () {
    var showing = $tableWrap.style.display !== "none";
    $tableWrap.style.display = showing ? "none" : "block";
    $toggleTable.setAttribute("aria-expanded", String(!showing));
    $toggleTable.textContent = showing ? "Als Tabelle anzeigen" : "Tabelle ausblenden";
  });

  /* ---------- Hauptberechnung ---------- */
  function renderAll() {
    if (!currentParsed) return;
    var nachtanteilFrac = num($nachtanteil, 30) / 100;
    var klimaActive = $klimaJa.getAttribute("aria-pressed") === "true";
    var nachtanteilKlimaFrac = num($nachtanteilKlima, 5) / 100;
    var days = buildDayNightSeries(currentParsed.days, nachtanteilFrac, klimaActive, nachtanteilKlimaFrac);
    simDays = days;
    var eta = num($eta, 90) / 100;
    var thresholdFrac = num($schwelle, 95) / 100;
    var strompreisCt = num($strompreis, 32);

    var leistungVorschlag = suggestLeistung(currentParsed.days);
    if (!leistungTouched) $leistung.value = leistungVorschlag.value;
    document.getElementById("leistung-hint").textContent =
      "Vorschlag aus PV-Spitzenleistung: höchster Tagesertrag ÷ 5 Volllaststunden ≈ " + leistungVorschlag.peakKw.toFixed(1) +
      " kW → " + leistungVorschlag.n + "× " + leistungVorschlag.step + "-kW-Wechselrichter = " + leistungVorschlag.value + " kW. Frei überschreibbar.";
    var leistungKw = num($leistung, 3);
    var ladestundenVal = num($ladestunden, 1460);

    var numDays = days.length;
    var annualFactor = numDays > 0 ? 365 / numDays : 1;
    var totalVerbrauch = days.reduce(function (s, d) { return s + d.verbrauch; }, 0);
    var totalErtrag = days.reduce(function (s, d) { return s + d.ertrag; }, 0);

    var klassisch = buildKlassischCurve(days, CAPACITIES, eta);
    var klassischEur = [], mispelEur = [], autarkie = [], einspeisungMitJahr = [];

    klassisch.forEach(function (r) {
      var avoidedNetzbezug = (klassisch[0].netzbezugMit - r.netzbezugMit) * annualFactor;
      var valK = avoidedNetzbezug * strompreisCt / 100;
      var arb = arbitrageForCapacity(pricePre, r.c, leistungKw, ladestundenVal, eta);
      var valArb = arb.volumeKwhYear * arb.rateCt / 100;
      klassischEur.push(valK);
      mispelEur.push(valK + valArb);
      einspeisungMitJahr.push(r.einspeisungMit * annualFactor);
      var netzbezugJahr = r.netzbezugMit * annualFactor;
      var verbrauchJahr = totalVerbrauch * annualFactor;
      autarkie.push(verbrauchJahr > 0 ? Math.max(0, (verbrauchJahr - netzbezugJahr) / verbrauchJahr) : 0);
    });

    var curveK = CAPACITIES.map(function (c, i) { return { c: c, value: klassischEur[i] }; });
    var curveM = CAPACITIES.map(function (c, i) { return { c: c, value: mispelEur[i] }; });
    var recK = findRecommended(curveK, thresholdFrac);
    var recM = findRecommended(curveM, thresholdFrac);

    // ---- Kontext ----
    $anlageTitel.textContent = currentParsed.anlage ? String(currentParsed.anlage) : "Gebäude";
    $anlageSub.textContent = "Jahr " + (currentParsed.jahr || "–") + " · " + numDays + " erfasste Tage";
    $ctxVerbrauch.textContent = fmtKWH.format(totalVerbrauch * annualFactor) + " kWh/Jahr";
    $ctxErtrag.textContent = fmtKWH.format(totalErtrag * annualFactor) + " kWh/Jahr";
    $ctxZeitraum.textContent = days[0].label + " – " + days[days.length - 1].label;
    $ctxSpeicherErkannt.innerHTML = currentParsed.hasBattery
      ? '<span class="chip status-warn" style="padding:2px 8px;">ja – Spalten unbenutzt, Modell rechnet ab 0 kWh</span>'
      : '<span class="chip status-good" style="padding:2px 8px;">nein</span>';
    $noteHochrechnung.textContent = Math.abs(numDays - 365) > 3
      ? "Hinweis: " + numDays + " Tage erfasst, Jahreswerte oben und unten sind auf 365 Tage hochgerechnet."
      : "";

    // ---- Ergebniskarten ----
    $rvKlassisch.innerHTML = recK.c + '<span class="cur">kWh</span>';
    $rnKlassisch.textContent = "≈ " + fmtEUR.format(klassischEur[CAPACITIES.indexOf(recK.c)]) + " €/Jahr Ersparnis, Autarkiegrad ≈ " + fmtPct.format(autarkie[CAPACITIES.indexOf(recK.c)] * 100) + " %.";

    $rvMispel.innerHTML = recM.c + '<span class="cur">kWh</span>';
    $rnMispel.textContent = "≈ " + fmtEUR.format(mispelEur[CAPACITIES.indexOf(recM.c)]) + " €/Jahr Ersparnis (inkl. Netz-Arbitrage)" +
      (pricePre ? "." : " — reale Preisdaten nicht verfügbar, entspricht dem Klassisch-Szenario.");

    chartState = { capacities: CAPACITIES, klassischEur: klassischEur, mispelEur: mispelEur, autarkie: autarkie, einspeisungMitJahr: einspeisungMitJahr, recK: recK, recM: recM };
    renderChart(chartState);
    renderTable(chartState);

    if (!testgroesseTouched) {
      $testgroesse.value = recK.c;
      $testgroesseSlider.value = recK.c;
    }
    renderUnterdeckung();
    flowCtx = { days: days, eta: eta, leistungKw: leistungKw, ladestundenVal: ladestundenVal, capacityKwh: recM.c };
    renderFlowChart();
    if (!$spotpreiseBody.hidden) renderSpotpreise();

    $results.hidden = false;
  }

  /* ---------- Spotmarktpreise: Ø Tag/Nacht + Opportunitätskosten (Option) ---------- */
  function renderSpotpreise() {
    if (!priceDayNight) {
      $ctxPreisTag.textContent = "–";
      $ctxPreisNacht.textContent = "–";
      $ctxPreisZeitraum.textContent = "–";
      $spotpreiseHinweis.textContent = "Reale Preisdaten nicht verfügbar.";
      return;
    }
    $ctxPreisTag.textContent = priceDayNight.avgDayCt.toFixed(1) + " ct/kWh";
    $ctxPreisNacht.textContent = priceDayNight.avgNightCt.toFixed(1) + " ct/kWh";
    $ctxPreisZeitraum.textContent = priceDataPeriodLabel(window.MISPEL_PREISDATEN);

    if (!chartState) {
      $spotpreiseHinweis.textContent = "Datei laden, um die Opportunitätskosten für die empfohlene Speichergröße zu sehen.";
      return;
    }
    var idxM = chartState.capacities.indexOf(chartState.recM.c);
    var restEinspeisung = chartState.einspeisungMitJahr[idxM];
    var opportunitaet = restEinspeisung * priceDayNight.avgDayCt / 100;
    $spotpreiseHinweis.innerHTML =
      "Beim MiSpeL-Speicher (" + chartState.recM.c + " kWh) bleiben rechnerisch noch " + fmtKWH.format(restEinspeisung) + " kWh/Jahr ungenutzte Einspeisung. " +
      "Am Spotmarkt hätte das im Schnitt nur <strong>" + fmtEUR.format(opportunitaet) + " €/Jahr</strong> eingebracht (Ø " + priceDayNight.avgDayCt.toFixed(1) + " ct/kWh tagsüber) " +
      "– deutlich weniger, als ein größerer Speicher an zusätzlicher Ersparnis bringen würde. Das zeigt: exportierter Tagesüberschuss ist am Spotmarkt wenig wert, im Speicher für die Nacht dagegen deutlich mehr.";
  }

  /* ---------- Tagesgenaue Prüfung: Tage mit Rest-Netzbezug trotz Speicher ---------- */
  function renderUnterdeckung() {
    if (!currentParsed || !simDays) return;
    var days = simDays;
    var eta = num($eta, 90) / 100;
    var numDays = days.length;
    var annualFactor = numDays > 0 ? 365 / numDays : 1;
    var capacityKwh = num($testgroesse, 0);

    var r = simulateCapacity(days, capacityKwh, eta, true);
    var shortfallDays = r.detail.filter(function (d) { return d.rest > 0.01; });
    shortfallDays.sort(function (a, b) { return b.rest - a.rest; });

    $ctxTageUnterdeckung.textContent = shortfallDays.length + " von " + numDays;
    $ctxUnterdeckungMax.textContent = shortfallDays.length ? fmtKWH.format(shortfallDays[0].rest) + " kWh (" + shortfallDays[0].label + ")" : "–";
    $ctxUnterdeckungSumme.textContent = fmtKWH.format(r.netzbezugMit * annualFactor) + " kWh/Jahr";

    $unterdeckungSub.textContent = shortfallDays.length
      ? shortfallDays.length + " Tage bei " + fmtKWH.format(capacityKwh) + " kWh Speicher mit Rest-Netzbezug, größte Unterdeckung zuerst."
      : "Bei " + fmtKWH.format(capacityKwh) + " kWh Speicher gab es an keinem erfassten Tag eine Unterdeckung.";

    var rows = "";
    shortfallDays.forEach(function (d) {
      rows += "<tr><td>" + d.label + "</td><td>" + fmtKWH.format(d.ueberschuss) + " kWh</td><td>" + fmtKWH.format(d.bedarf) + " kWh</td><td>" + fmtKWH.format(d.gedeckt) + " kWh</td><td>" + fmtKWH.format(d.rest) + " kWh</td></tr>";
    });
    $tableBodyUnterdeckung.innerHTML = rows;
  }

  /* ============================================================
     Energiefluss-Simulation je Tag (für die Jahres-Grafik unten): zeigt,
     woraus der TATSÄCHLICHE VERBRAUCH jedes Tages gedeckt wurde — daher
     zwei getrennte Speicher-Konten (PV-geladen / Netz-geladen), weil eine
     an Tag X geladene kWh nicht zwingend an Tag X wieder entnommen wird.
     Entladung wird proportional zur aktuellen Zusammensetzung der beiden
     Konten zugeordnet. Die drei Flächen summieren sich dadurch exakt zum
     Tagesverbrauch (wie im echten Monitoring-Tool). Netzladung ist ein
     fixes Tagesbudget aus Ladeleistung × (verfügbare günstige Stunden/Jahr
     ÷ 365) — dieselbe Annahme wie in der Jahres-Arbitrage-Schätzung, hier
     nur tagesgenau angewendet.
     ============================================================ */
  function simulateFlows(days, capacityKwh, eta, leistungKw, ladestundenVerfuegbar, misPelActive) {
    var socPV = 0, socGrid = 0;
    var dailyGridBudget = misPelActive ? leistungKw * (ladestundenVerfuegbar / 365) : 0;
    return days.map(function (d) {
      var pvDirekt = d.ertrag - d.einspeisung0; // PV, sofort ohne Speicher genutzt
      var room = capacityKwh - (socPV + socGrid);
      var ladenPV = Math.min(d.einspeisung0, room > 0 ? room : 0);
      socPV += ladenPV * eta;
      room = capacityKwh - (socPV + socGrid);
      var ladenNetz = Math.min(dailyGridBudget, room > 0 ? room : 0);
      socGrid += ladenNetz * eta;

      var deficit = d.netzbezug0;
      var totalSoc = socPV + socGrid;
      var entladen = Math.min(deficit, totalSoc);
      var entladenPV = 0, entladenGrid = 0;
      if (totalSoc > 0 && entladen > 0) {
        entladenPV = entladen * (socPV / totalSoc);
        entladenGrid = entladen - entladenPV;
      }
      socPV -= entladenPV;
      socGrid -= entladenGrid;
      var restNetzbezug = deficit - entladen;

      return {
        label: d.label,
        pvDirekt: pvDirekt, // PV, sofort ohne Speicher genutzt
        entladenPV: entladenPV, // aus Speicher entnommen, urspr. aus PV geladen
        pvGesamt: pvDirekt + entladenPV, // "aus PV" = direkt genutzt + aus Speicher (urspr. PV) entnommen
        netzGenutzt: entladenGrid, // aus Speicher entnommen, urspr. günstig aus dem Netz geladen (MiSpeL)
        restNetzbezug: restNetzbezug
      };
    });
  }

  /* ---------- Energiefluss über das Jahr (gestapelte Fläche) ---------- */
  var $flowMispelJa = document.getElementById("flow-mispel-ja");
  var $flowMispelNein = document.getElementById("flow-mispel-nein");
  var $flowSize = document.getElementById("flow-size");
  var $flowTooltip = document.getElementById("flow-tooltip");
  var flowMispelActive = true;
  $flowMispelJa.addEventListener("click", function () {
    flowMispelActive = true;
    setYesNo($flowMispelJa, $flowMispelNein, true);
    if (currentParsed) renderFlowChart();
  });
  $flowMispelNein.addEventListener("click", function () {
    flowMispelActive = false;
    setYesNo($flowMispelJa, $flowMispelNein, false);
    if (currentParsed) renderFlowChart();
  });

  var flowCtx = null; // { days, eta, leistungKw, ladestundenVal, capacityKwh }

  var $toggleTableFlow = document.getElementById("toggle-table-flow");
  var $flowTableWrap = document.getElementById("flow-table-wrap");
  var $tableBodyFlow = document.getElementById("table-body-flow");
  $toggleTableFlow.addEventListener("click", function () {
    var showing = $flowTableWrap.style.display !== "none";
    $flowTableWrap.style.display = showing ? "none" : "block";
    $toggleTableFlow.setAttribute("aria-expanded", String(!showing));
    $toggleTableFlow.textContent = showing ? "Als Tabelle anzeigen" : "Tabelle ausblenden";
  });

  function renderFlowTable(flows) {
    var rows = "";
    flows.forEach(function (f) {
      var mispelAn = f.entladenPV + f.netzGenutzt;
      rows += "<tr><td>" + f.label + "</td><td>" + fmtKWH.format(f.pvDirekt) + " kWh</td><td>" + fmtKWH.format(f.entladenPV) + " kWh</td><td>" + fmtKWH.format(mispelAn) + " kWh</td><td>" + fmtKWH.format(f.restNetzbezug) + " kWh</td></tr>";
    });
    $tableBodyFlow.innerHTML = rows;
  }

  function renderFlowChart() {
    if (!flowCtx) return;
    $flowSize.textContent = flowCtx.capacityKwh;
    var flows = simulateFlows(flowCtx.days, flowCtx.capacityKwh, flowCtx.eta, flowCtx.leistungKw, flowCtx.ladestundenVal, flowMispelActive);
    renderFlowTable(flows);

    var svg = document.getElementById("flow-chart");
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var W = 900, H = 340, padL = 56, padR = 16, padT = 16, padB = 32;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var n = flows.length;
    var maxVal = flows.reduce(function (m, f) { return Math.max(m, f.pvGesamt + f.netzGenutzt + f.restNetzbezug); }, 1) * 1.1;

    function x(i) { return padL + (i / Math.max(1, n - 1)) * innerW; }
    function y(v) { return padT + innerH - (v / maxVal) * innerH; }

    var svgns = "http://www.w3.org/2000/svg";
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    function el(tag, attrs) {
      var node = document.createElementNS(svgns, tag);
      for (var k in attrs) node.setAttribute(k, attrs[k]);
      return node;
    }

    var steps = 4;
    for (var s = 0; s <= steps; s++) {
      var v = (maxVal / steps) * s;
      var gy = y(v);
      svg.appendChild(el("line", { x1: padL, x2: W - padR, y1: gy, y2: gy, class: "lc-grid-line" }));
      var lab = el("text", { x: padL - 8, y: gy + 4, class: "lc-axis-label", "text-anchor": "end" });
      lab.textContent = fmtKWH.format(v) + " kWh";
      svg.appendChild(lab);
    }
    svg.appendChild(el("line", { x1: padL, x2: W - padR, y1: padT + innerH, y2: padT + innerH, class: "lc-axis-line" }));

    // Monats-Beschriftung auf der X-Achse (grober Rasterschnitt über n Tage)
    var monthNames = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
    for (var mm = 0; mm < 12; mm++) {
      var idx = Math.round((mm / 12) * n);
      if (idx >= n) continue;
      var lab2 = el("text", { x: x(idx), y: padT + innerH + 18, class: "lc-axis-label", "text-anchor": "middle" });
      lab2.textContent = monthNames[mm];
      svg.appendChild(lab2);
    }

    function areaPath(getLow, getHigh) {
      var d = "";
      for (var i = 0; i < n; i++) d += (i === 0 ? "M" : "L") + x(i).toFixed(1) + "," + y(getHigh(i)).toFixed(1) + " ";
      for (var j = n - 1; j >= 0; j--) d += "L" + x(j).toFixed(1) + "," + y(getLow(j)).toFixed(1) + " ";
      return d + "Z";
    }
    var cum1 = flows.map(function (f) { return f.pvGesamt; });
    var cum2 = flows.map(function (f, i) { return cum1[i] + f.netzGenutzt; });
    var cum3 = flows.map(function (f, i) { return cum2[i] + f.restNetzbezug; });

    svg.appendChild(el("path", { d: areaPath(function () { return 0; }, function (i) { return cum1[i]; }), fill: "var(--chart-pv)", opacity: 0.85 }));
    if (flowMispelActive) svg.appendChild(el("path", { d: areaPath(function (i) { return cum1[i]; }, function (i) { return cum2[i]; }), fill: "var(--chart-market)", opacity: 0.85 }));
    svg.appendChild(el("path", { d: areaPath(function (i) { return cum2[i]; }, function (i) { return cum3[i]; }), fill: "var(--chart-unused)", opacity: 0.85 }));

    var hit = el("rect", { x: padL, y: padT, width: innerW, height: innerH, class: "lc-hit-area" });
    var crosshair = el("line", { x1: 0, x2: 0, y1: padT, y2: padT + innerH, class: "lc-crosshair" });
    crosshair.style.display = "none";
    svg.appendChild(crosshair);
    svg.appendChild(hit);
    hit.addEventListener("mousemove", function (e) {
      var rect = svg.getBoundingClientRect();
      var px = (e.clientX - rect.left) * (W / rect.width);
      var i = Math.round(((px - padL) / innerW) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      crosshair.style.display = "block";
      crosshair.setAttribute("x1", x(i)); crosshair.setAttribute("x2", x(i));
      $flowTooltip.hidden = false;
      $flowTooltip.style.left = ((x(i) / W) * rect.width) + "px";
      $flowTooltip.innerHTML =
        '<div class="tt-title">' + flows[i].label + '</div>' +
        '<div class="tt-row"><span class="tt-swatch" style="background:var(--chart-pv)"></span>Aus PV: ' + fmtKWH.format(flows[i].pvGesamt) + ' kWh</div>' +
        (flowMispelActive ? '<div class="tt-row"><span class="tt-swatch" style="background:var(--chart-market)"></span>Aus Speicher, günstig vom Netz geladen (MiSpeL): ' + fmtKWH.format(flows[i].netzGenutzt) + ' kWh</div>' : '') +
        '<div class="tt-row"><span class="tt-swatch" style="background:var(--chart-unused)"></span>Direkter Netzbezug: ' + fmtKWH.format(flows[i].restNetzbezug) + ' kWh</div>';
    });
    hit.addEventListener("mouseleave", function () { crosshair.style.display = "none"; $flowTooltip.hidden = true; });
  }
})();
