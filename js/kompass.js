(function () {
  "use strict";

  /* ---------- Tabs ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  var panels = { p1: document.getElementById("p1"), p2: document.getElementById("p2"), p4: document.getElementById("p4") };
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      tabs.forEach(function (t) { t.setAttribute("aria-selected", "false"); });
      Object.keys(panels).forEach(function (k) { panels[k].hidden = true; });
      tab.setAttribute("aria-selected", "true");
      panels[tab.dataset.target].hidden = false;
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  /* ---------- Formatting helpers ---------- */
  var fmtEUR = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
  var fmtKWH = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

  /* ---------- Inputs ---------- */
  var $pv = document.getElementById("in-pv");
  var $speicher = document.getElementById("in-speicher");
  var $jahresverbrauch = document.getElementById("in-jahresverbrauch");
  var $speicherLeistung = document.getElementById("in-speicher-leistung");
  var $netzSpeicher = document.getElementById("in-netz-speicher");
  var $evJa = document.getElementById("ev-ja");
  var $evNein = document.getElementById("ev-nein");
  var $evFields = document.getElementById("ev-fields");
  var $evAkku = document.getElementById("in-ev-akku");
  var $evLeistung = document.getElementById("in-ev-leistung");
  var $netzEv = document.getElementById("in-netz-ev");
  var $zyklen = document.getElementById("in-zyklen");
  var $ladestunden = document.getElementById("in-ladestunden");
  var $strompreis = document.getElementById("in-strompreis");
  var $arbitrage = document.getElementById("in-arbitrage");
  var $messkosten = document.getElementById("in-messkosten");

  var $ctxSpeicherMax = document.getElementById("ctx-speicher-max");
  var $ctxDeckel = document.getElementById("ctx-deckel");
  var $ctxZulaessig = document.getElementById("ctx-zulaessig");
  var $ctxEvMax = document.getElementById("ctx-ev-max");
  var $warnSpeicher = document.getElementById("warn-speicher");
  var $warnEv = document.getElementById("warn-ev");
  var $warnVerbrauch = document.getElementById("warn-verbrauch");

  function num(el, fallback) {
    var v = parseFloat(el.value);
    return isFinite(v) && v >= 0 ? v : fallback;
  }

  /* ---------- Ja/Nein: E-Auto vorhanden? ---------- */
  function setEvVorhanden(vorhanden) {
    $evJa.setAttribute("aria-pressed", String(vorhanden));
    $evNein.setAttribute("aria-pressed", String(!vorhanden));
    $evFields.hidden = !vorhanden;
  }
  $evJa.addEventListener("click", function () { setEvVorhanden(true); renderAll(); });
  $evNein.addEventListener("click", function () { setEvVorhanden(false); renderAll(); });

  function computeModel() {
    var pvKwp = num($pv, 0);
    var speicherKwh = num($speicher, 0);
    var jahresverbrauchKwh = num($jahresverbrauch, 0);
    var speicherLeistung = num($speicherLeistung, 0);
    var netzSpeicherGewuenscht = num($netzSpeicher, 0);
    var evVorhanden = $evJa.getAttribute("aria-pressed") === "true";
    var evLeistung = num($evLeistung, 0);
    var netzEvGewuenscht = num($netzEv, 0);
    var zyklen = num($zyklen, 0);
    var ladestunden = num($ladestunden, 0);
    var strompreisCt = num($strompreis, 0);
    var arbitrageCt = num($arbitrage, 0);
    var messkosten = num($messkosten, 0);

    // Speicher-Durchsatz: PV-Anteil bleibt eine Rechen-Annahme (Vollzyklen, Modul 04),
    // Netzanteil ist jetzt eine direkte, vom Kunden gewünschte kWh/Jahr-Menge, gekappt
    // durch die technische Ladeleistung (Wechselrichter-Flaschenhals) über die verfügbaren
    // günstigen Ladestunden.
    var pvKwhTeil = speicherKwh * zyklen;
    var speicherNetzMax = speicherLeistung * ladestunden;
    var speicherNetzKwh = Math.min(netzSpeicherGewuenscht, speicherNetzMax);
    var speicherGekappt = netzSpeicherGewuenscht > speicherNetzMax;

    var evNetzMax = evVorhanden ? evLeistung * ladestunden : 0;
    var evNetzKwh = evVorhanden ? Math.min(netzEvGewuenscht, evNetzMax) : 0;
    var evGekappt = evVorhanden && netzEvGewuenscht > evNetzMax;

    var netzKwh = speicherNetzKwh + evNetzKwh;
    var durchsatz = pvKwhTeil + netzKwh;
    var deckel = 500 * pvKwp;
    var pauschalZulaessig = pvKwp > 0 && pvKwp <= 30;

    // Option A – Ausschließlichkeit: nur PV-Anteil ladbar, Netzanteil bleibt ungenutztes Potenzial
    var a = {
      pv: pvKwhTeil,
      markt: 0,
      ungenutzt: netzKwh,
      value: pvKwhTeil * strompreisCt / 100
    };

    // Option B – Abgrenzung: voller Durchsatz möglich, exakt getrennt
    var b = {
      pv: pvKwhTeil,
      markt: netzKwh,
      ungenutzt: 0,
      value: (pvKwhTeil * strompreisCt / 100) + (netzKwh * arbitrageCt / 100) - messkosten
    };

    // Option C – Pauschale: nur bis 30 kWp, gedeckelter Förderanteil
    var foerderfaehigC = Math.min(durchsatz, deckel);
    var restC = Math.max(0, durchsatz - deckel);
    var c = {
      pv: foerderfaehigC,
      markt: restC,
      ungenutzt: 0,
      value: pauschalZulaessig ? (foerderfaehigC * strompreisCt / 100) + (restC * arbitrageCt / 100) : null,
      applicable: pauschalZulaessig
    };

    // Jahresstromverbrauch: der Durchsatz aus Speicher + E-Auto kann real nur selbst
    // verbraucht werden, wenn der Haushalt übers Jahr mindestens so viel Strom braucht.
    var verbrauchUeberschritten = durchsatz > jahresverbrauchKwh;

    return {
      pvKwp: pvKwp, speicherKwh: speicherKwh, durchsatz: durchsatz, deckel: deckel, pauschalZulaessig: pauschalZulaessig,
      speicherNetzMax: speicherNetzMax, speicherGekappt: speicherGekappt,
      evVorhanden: evVorhanden, evNetzMax: evNetzMax, evGekappt: evGekappt,
      jahresverbrauchKwh: jahresverbrauchKwh, verbrauchUeberschritten: verbrauchUeberschritten,
      a: a, b: b, c: c
    };
  }

  /* ---------- Echtdaten-Berechnung (Modul 03) ----------
     Simuliert je Tag des geladenen Day-Ahead-Preisjahres (window.MISPEL_PREISDATEN,
     Quelle energy-charts.info), wie viel Energie realistisch in den günstigsten
     Viertelstunden geladen und in den teuersten wieder verkauft/genutzt werden kann
     (begrenzt durch Ladeleistung und Speicherkapazität bzw. die vom Nutzer
     eingestellten "günstigen Ladestunden pro Jahr"). Daraus ergibt sich eine
     anlagenscharfe effektive Arbitrage-Spanne (ct/kWh), die die pauschale
     Annahme im Feld "Arbitrage-Spanne" ersetzt. Rundwirkungsgrad 90 % ist eine
     feste, im Statustext ausgewiesene Annahme (kein eigenes Eingabefeld, um das
     Formular schlank zu halten). */
  function computeRealPriceRate(speicherKwh, speicherLeistung, ladestundenVal) {
    var data = window.MISPEL_PREISDATEN;
    if (!data || !data.prices || !data.prices.length || speicherKwh <= 0 || speicherLeistung <= 0) return null;

    var stepMin = data.step_minutes || 15;
    var perDayCount = Math.round((24 * 60) / stepMin);
    var nDays = Math.floor(data.prices.length / perDayCount);
    if (nDays < 1) return null;

    var eff = 0.9;
    var hoursPerDay = ladestundenVal / 365;
    var dailyVol = Math.min(speicherKwh, speicherLeistung * hoursPerDay);
    if (dailyVol <= 0) return null;
    var maxPerSlot = speicherLeistung * (stepMin / 60);

    function allocate(sortedPrices, vol) {
      var remaining = vol, cost = 0, energy = 0;
      for (var i = 0; i < sortedPrices.length && remaining > 0; i++) {
        var take = Math.min(maxPerSlot, remaining);
        cost += (sortedPrices[i] * take) / 1000; // EUR/MWh * kWh / 1000 = EUR
        energy += take;
        remaining -= take;
      }
      return { cost: cost, energy: energy };
    }

    var totalChargeCost = 0, totalChargeEnergy = 0, totalSellValue = 0;
    for (var d = 0; d < nDays; d++) {
      var day = data.prices.slice(d * perDayCount, (d + 1) * perDayCount);
      var asc = day.slice().sort(function (a, b) { return a - b; });
      var desc = day.slice().sort(function (a, b) { return b - a; });
      var c = allocate(asc, dailyVol);
      var s = allocate(desc, dailyVol * eff);
      totalChargeCost += c.cost;
      totalChargeEnergy += c.energy;
      totalSellValue += s.cost;
    }
    if (totalChargeEnergy <= 0) return null;

    return {
      rateCt: ((totalSellValue - totalChargeCost) / totalChargeEnergy) * 100,
      volumeKwhYear: (totalChargeEnergy * 365) / nDays,
      nDays: nDays,
      eff: eff
    };
  }

  function preisdatenPeriodLabel() {
    var data = window.MISPEL_PREISDATEN;
    if (!data || !data.start_utc) return "";
    var start = new Date(data.start_utc);
    var end = new Date(start.getTime() + data.n_days * 24 * 3600 * 1000);
    var fmt = function (dt) { return dt.toLocaleDateString("de-DE", { month: "short", year: "numeric" }); };
    return fmt(start) + "–" + fmt(end);
  }

  var $btnEchtdaten = document.getElementById("btn-echtdaten");
  var $echtdatenStatus = document.getElementById("echtdaten-status");
  if ($btnEchtdaten) {
    $btnEchtdaten.addEventListener("click", function () {
      var speicherKwh = num($speicher, 0);
      var speicherLeistungVal = num($speicherLeistung, 0);
      var ladestundenVal = num($ladestunden, 0);
      var result = computeRealPriceRate(speicherKwh, speicherLeistungVal, ladestundenVal);
      if (!result) {
        $echtdatenStatus.textContent = "Für die Echtdaten-Berechnung bitte Speicherkapazität und Ladeleistung oberhalb 0 eintragen.";
        $echtdatenStatus.classList.remove("active");
        return;
      }
      $arbitrage.value = result.rateCt.toFixed(1);
      $echtdatenStatus.textContent = "Echtdaten aktiv: " + result.rateCt.toFixed(1) + " ct/kWh effektive Arbitrage-Spanne für " + fmtKWH.format(speicherKwh) + " kWh / " + speicherLeistungVal + " kW, simuliert aus " + result.nDays + " Tagen realen Day-Ahead-Preisen (energy-charts.info, " + preisdatenPeriodLabel() + ", " + Math.round(result.eff * 100) + " % Wirkungsgrad angenommen).";
      $echtdatenStatus.classList.add("active");
      renderAll();
    });
  }

  /* ---------- Panel 3 render ---------- */
  function renderContext(m) {
    $ctxSpeicherMax.textContent = fmtKWH.format(m.speicherNetzMax) + " kWh/Jahr";
    $ctxDeckel.textContent = fmtKWH.format(m.deckel) + " kWh/Jahr";
    if (m.pvKwp <= 0) {
      $ctxZulaessig.innerHTML = '<span class="chip" style="padding:2px 8px;">PV-Leistung eingeben</span>';
    } else if (m.pauschalZulaessig) {
      $ctxZulaessig.innerHTML = '<span class="chip status-good" style="padding:2px 8px;">möglich</span>';
    } else {
      $ctxZulaessig.innerHTML = '<span class="chip status-critical" style="padding:2px 8px;">nicht möglich (&gt; 30 kWp)</span>';
    }
    $warnSpeicher.hidden = !m.speicherGekappt;
    if (m.speicherGekappt) {
      $warnSpeicher.textContent = "Gewünschte Menge übersteigt die technisch mögliche Ladeleistung – wird auf " + fmtKWH.format(m.speicherNetzMax) + " kWh/Jahr gekappt.";
    }

    $warnVerbrauch.hidden = !m.verbrauchUeberschritten;
    if (m.verbrauchUeberschritten) {
      $warnVerbrauch.textContent = "Speicher + E-Auto würden zusammen " + fmtKWH.format(m.durchsatz) + " kWh/Jahr umsetzen – mehr als Ihr angegebener Jahresstromverbrauch von " + fmtKWH.format(m.jahresverbrauchKwh) + " kWh. Das kann real nicht vollständig selbst verbraucht werden.";
    }

    if (m.evVorhanden) {
      $ctxEvMax.textContent = fmtKWH.format(m.evNetzMax) + " kWh/Jahr";
      $warnEv.hidden = !m.evGekappt;
      if (m.evGekappt) {
        $warnEv.textContent = "Gewünschte Menge übersteigt die technisch mögliche Ladeleistung – wird auf " + fmtKWH.format(m.evNetzMax) + " kWh/Jahr gekappt.";
      }
    }
  }

  /* ---------- Panel 4 render ---------- */
  var $rvA = document.getElementById("rv-a"), $rnA = document.getElementById("rn-a"), $rcA = document.getElementById("rc-a");
  var $rvB = document.getElementById("rv-b"), $rnB = document.getElementById("rn-b"), $rcB = document.getElementById("rc-b");
  var $rvC = document.getElementById("rv-c"), $rnC = document.getElementById("rn-c"), $rcC = document.getElementById("rc-c");
  var $barRows = document.getElementById("bar-rows");
  var $tableBody = document.getElementById("table-body");

  function euroStr(v) {
    return fmtEUR.format(Math.round(v)) + '<span class="cur">€/Jahr</span>';
  }

  function renderResults(m) {
    $rvA.innerHTML = euroStr(m.a.value);
    $rnA.textContent = m.a.ungenutzt > 0
      ? fmtKWH.format(m.a.ungenutzt) + " kWh/Jahr Netzstrom-Potenzial bleiben ungenutzt, da nicht zulässig."
      : "Gesamter Durchsatz stammt aus PV-Überschuss.";
    $rcA.classList.remove("disabled");

    $rvB.innerHTML = euroStr(m.b.value);
    $rnB.textContent = fmtKWH.format(m.b.pv) + " kWh PV-Anteil + " + fmtKWH.format(m.b.markt) + " kWh Netzanteil, exakt getrennt.";
    $rcB.classList.remove("disabled");

    if (m.c.applicable) {
      $rvC.innerHTML = euroStr(m.c.value);
      $rnC.textContent = fmtKWH.format(m.c.pv) + " kWh pauschal förderfähig (Deckel " + fmtKWH.format(m.deckel) + " kWh), Rest " + fmtKWH.format(m.c.markt) + " kWh am Markt.";
      $rcC.classList.remove("disabled");
    } else {
      $rvC.innerHTML = "n/a";
      $rnC.innerHTML = '<span style="color:var(--error-text)">Nicht anwendbar – nur für PV-Anlagen bis 30 kWp.</span>';
      $rcC.classList.add("disabled");
    }
  }

  function seg(width, colorVar, label, kwh, tooltip, isOnly) {
    if (width <= 0) return "";
    return '<div class="bar-seg' + (isOnly ? ' only' : '') + '" style="width:' + width + '%; background:' + colorVar + '" tabindex="0">' +
      (width > 14 ? '<span class="seg-label">' + fmtKWH.format(kwh) + '</span>' : '') +
      '<span class="seg-tooltip">' + label + ': ' + fmtKWH.format(kwh) + ' kWh</span>' +
      '</div>';
  }

  function renderBar(rowLabel, rowSub, data, valueText) {
    var total = data.pv + data.markt + data.ungenutzt;
    var pvPct = total > 0 ? (data.pv / total * 100) : 0;
    var marktPct = total > 0 ? (data.markt / total * 100) : 0;
    var ungenutztPct = total > 0 ? (data.ungenutzt / total * 100) : 0;
    var segCount = (data.pv > 0 ? 1 : 0) + (data.markt > 0 ? 1 : 0) + (data.ungenutzt > 0 ? 1 : 0);

    var html = '<div class="bar-row">';
    html += '<div class="row-label">' + rowLabel + '<span class="sub">' + rowSub + '</span></div>';
    html += '<div style="display:flex; align-items:center;">';
    html += '<div class="bar-track">';
    html += seg(pvPct, "var(--chart-pv)", "Geförderter PV-Anteil", data.pv, "", segCount === 1);
    html += seg(marktPct, "var(--chart-market)", "Freier Marktanteil", data.markt, "", segCount === 1);
    html += seg(ungenutztPct, "var(--chart-unused)", "Ungenutztes Potenzial", data.ungenutzt, "", segCount === 1);
    html += '</div>';
    html += '<span class="bar-total">' + valueText + '</span>';
    html += '</div></div>';
    return html;
  }

  function renderChart(m) {
    var rows = "";
    rows += renderBar("Ausschließlichkeit", "kein Mischbetrieb", m.a, fmtEUR.format(Math.round(m.a.value)) + " €");
    rows += renderBar("Abgrenzungsoption", "exakte Trennung", m.b, fmtEUR.format(Math.round(m.b.value)) + " €");
    if (m.c.applicable) {
      rows += renderBar("Pauschaloption", "bis 30 kWp", m.c, fmtEUR.format(Math.round(m.c.value)) + " €");
    } else {
      rows += renderBar("Pauschaloption", "nicht anwendbar", { pv: 0, markt: 0, ungenutzt: 0 }, "n/a");
    }
    $barRows.innerHTML = rows;

    var tbody = "";
    tbody += "<tr><td>Ausschließlichkeit</td><td>" + fmtKWH.format(m.a.pv) + "</td><td>" + fmtKWH.format(m.a.markt) + "</td><td>" + fmtKWH.format(m.a.ungenutzt) + "</td><td>" + fmtEUR.format(Math.round(m.a.value)) + "</td></tr>";
    tbody += "<tr><td>Abgrenzungsoption</td><td>" + fmtKWH.format(m.b.pv) + "</td><td>" + fmtKWH.format(m.b.markt) + "</td><td>" + fmtKWH.format(m.b.ungenutzt) + "</td><td>" + fmtEUR.format(Math.round(m.b.value)) + "</td></tr>";
    tbody += "<tr><td>Pauschaloption</td><td>" + (m.c.applicable ? fmtKWH.format(m.c.pv) : "–") + "</td><td>" + (m.c.applicable ? fmtKWH.format(m.c.markt) : "–") + "</td><td>0</td><td>" + (m.c.applicable ? fmtEUR.format(Math.round(m.c.value)) : "n/a") + "</td></tr>";
    $tableBody.innerHTML = tbody;
  }

  /* ---------- Table toggle ---------- */
  var $toggleTable = document.getElementById("toggle-table");
  var $tableWrap = document.getElementById("table-wrap");
  $toggleTable.addEventListener("click", function () {
    var showing = $tableWrap.style.display !== "none";
    $tableWrap.style.display = showing ? "none" : "block";
    $toggleTable.setAttribute("aria-expanded", String(!showing));
    $toggleTable.textContent = showing ? "Als Tabelle anzeigen" : "Tabelle ausblenden";
  });

  /* ---------- Wire up live updates ---------- */
  function renderAll() {
    var m = computeModel();
    renderContext(m);
    renderResults(m);
    renderChart(m);
  }

  [$pv, $speicher, $jahresverbrauch, $speicherLeistung, $netzSpeicher, $evAkku, $evLeistung, $netzEv, $zyklen, $ladestunden, $strompreis, $arbitrage, $messkosten].forEach(function (el) {
    el.addEventListener("input", renderAll);
  });

  /* ---------- Regler unter den Eckdaten-Feldern (Modul 03), gekoppelt an das Zahlenfeld ---------- */
  function bindSlider(numId, sliderId) {
    var $num = document.getElementById(numId);
    var $slider = document.getElementById(sliderId);
    if (!$num || !$slider) return;
    $slider.addEventListener("input", function () {
      $num.value = $slider.value;
      renderAll();
    });
    $num.addEventListener("input", function () {
      var v = parseFloat($num.value);
      if (isFinite(v)) $slider.value = v;
    });
  }

  [
    ["in-pv", "in-pv-slider"],
    ["in-speicher", "in-speicher-slider"],
    ["in-jahresverbrauch", "in-jahresverbrauch-slider"],
    ["in-speicher-leistung", "in-speicher-leistung-slider"],
    ["in-netz-speicher", "in-netz-speicher-slider"],
    ["in-ev-akku", "in-ev-akku-slider"],
    ["in-ev-leistung", "in-ev-leistung-slider"],
    ["in-netz-ev", "in-netz-ev-slider"]
  ].forEach(function (pair) { bindSlider(pair[0], pair[1]); });

  setEvVorhanden(false);
  renderAll();
})();
