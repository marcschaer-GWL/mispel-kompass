/*
  Stückliste: Speicher- und Wechselrichter-Komponenten für die MiSpeL-Angebotskalkulation.
  Einzige Quelle für Modelle/Preise — neue Komponenten oder Preisänderungen nur HIER eintragen,
  damit Speicher- und Wechselrichter-Angebot nie aus zwei verschiedenen Listen auseinanderlaufen.

  EK-Preise + Modelle übernommen aus Konfigurator-Westafrika
  (packages/backend/src/services/priceConfigService.ts, DEFAULT_COMPONENTS, Stand 2026-10-03),
  ohne die reinen Westafrika-Positionen (ANENJI, 1-phasige DEYE-Variante, Transport, Provision) —
  MiSpeL-Gebäude sind deutsche Gewerbeimmobilien, immer 3-phasig.
*/
(function (global) {
  "use strict";

  var MARGIN_PCT = 35; // Marge in % auf den EK-Preis, wie Westafrika-Standardmarge
  var EXTRA_MONTAGE_PRO_ZUSATZGERAET_EUR = 15; // je weiterem Wechselrichter in einem Verbund (Parallelschaltung)
  // Das Deye-Datenblattlimit "max. 10 Stück parallel" (aus Konfigurator-Westafrika übernommen)
  // gilt nur für Geräte an EINEM gemeinsamen AC-Verteiler. Bei großen MiSpeL-Gewerbeanlagen
  // (Mieterstrom, viele hundert kW) werden ohnehin mehrere AC-Verteilpunkte gebraucht —
  // für die reine Preiskalkulation hier deshalb ein großzügiger Wert statt der elektrischen
  // 10er-Grenze, damit große Anlagen nicht ins Leere laufen (siehe Hauptstelle-Testfall,
  // 460 kW Vorschlag > 10×20 kW). Die Aufteilung auf mehrere Verteiler ist eine
  // Installationsplanungs-Frage, keine Preisfrage.
  var MAX_PARALLEL = 50;

  var STUECKLISTE = [
    // ---- Speicher (Batteriemodule, DEYE, dutchmart.nl netto) ----
    { id: "bat5", kategorie: "speicher", name: "Batterie 5 kWh (DEYE SE-G5.1 Pro-B)", capacityKWh: 5.12, ekPrice: 625.00 },
    { id: "bat12", kategorie: "speicher", name: "Batterie 11,8 kWh (DEYE SE-F12 C)", capacityKWh: 11.8, ekPrice: 1199.00 },
    { id: "bat16", kategorie: "speicher", name: "Batterie 16 kWh (DEYE SE-F16 C)", capacityKWh: 16, ekPrice: 1479.00 },

    // ---- Wechselrichter (DEYE, 3-phasig, dutchmart.nl netto) ----
    { id: "inv10", kategorie: "wechselrichter", name: "Wechselrichter 10 kW (DEYE 10K 3-phasig)", acKW: 10, ekPrice: 1384.90 },
    { id: "inv15", kategorie: "wechselrichter", name: "Wechselrichter 15 kW (DEYE 15K 3-phasig)", acKW: 15, ekPrice: 1611.50 },
    { id: "inv20", kategorie: "wechselrichter", name: "Wechselrichter 20 kW (DEYE 20K 3-phasig)", acKW: 20, ekPrice: 2220.90 },

    // ---- Dienstleistungen (Deutschland) ----
    // Reine Arbeitsleistung, keine EK-Quelle wie bei Speicher/Wechselrichter —
    // `preis` ist bereits der fertige Endkundenpreis (Pauschal, pro Anlage), ohne
    // zusätzliche Marge, analog zu montagePreis() in Konfigurator-Westafrika.
    // Preis noch 0 (Platzhalter) — von Marc beim ersten echten Angebot einzutragen.
    { id: "montageSpeicher", kategorie: "dienstleistung", name: "Montage Speicher", preis: 0 },
    { id: "elektrischerAnschluss", kategorie: "dienstleistung", name: "Elektrischer Anschluss", preis: 0 },
  ];

  function vkPrice(ekPrice) {
    return ekPrice * (1 + MARGIN_PCT / 100);
  }

  function byKategorie(kategorie) {
    return STUECKLISTE.filter(function (c) { return c.kategorie === kategorie; });
  }

  /* Günstigste Kombination aus Speicher-Modulen, die mindestens targetKWh erreicht.
     Unbounded-Knapsack über Centi-kWh-Schritte (× 100), analog zu chooseBatteryCombo()
     in Konfigurator-Westafrika (packages/shared/src/index.ts). */
  function chooseSpeicherKombi(targetKWh) {
    var items = byKategorie("speicher");
    if (targetKWh <= 0 || items.length === 0) {
      return { targetKWh: targetKWh, achievedKWh: 0, totalEkPrice: 0, totalVkPrice: 0, lines: [] };
    }

    var SCALE = 100;
    var capsCenti = items.map(function (c) { return Math.round(c.capacityKWh * SCALE); });
    var targetCenti = Math.max(1, Math.ceil(targetKWh * SCALE - 1e-6));
    var maxCapCenti = Math.max.apply(null, capsCenti);
    var upper = targetCenti + maxCapCenti - 1;

    var dp = new Array(upper + 1).fill(Infinity);
    var pick = new Array(upper + 1).fill(-1);
    dp[0] = 0;
    for (var c = 1; c <= upper; c++) {
      for (var i = 0; i < items.length; i++) {
        var cap = capsCenti[i];
        if (cap > c) continue;
        var candidate = dp[c - cap] + items[i].ekPrice;
        if (candidate < dp[c]) { dp[c] = candidate; pick[c] = i; }
      }
    }

    var bestC = -1, bestCost = Infinity;
    for (var cc = targetCenti; cc <= upper; cc++) {
      if (dp[cc] < bestCost) { bestCost = dp[cc]; bestC = cc; }
    }
    if (bestC === -1) return null;

    var counts = {};
    var cur = bestC;
    while (cur > 0) {
      var idx = pick[cur];
      counts[idx] = (counts[idx] || 0) + 1;
      cur -= capsCenti[idx];
    }

    var lines = Object.keys(counts).map(function (idxStr) {
      var idx = Number(idxStr), count = counts[idxStr], component = items[idx];
      return {
        componentId: component.id,
        name: component.name,
        capacityKWh: component.capacityKWh,
        count: count,
        ekPriceEach: component.ekPrice,
        vkPriceEach: vkPrice(component.ekPrice),
        ekLineTotal: component.ekPrice * count,
        vkLineTotal: vkPrice(component.ekPrice) * count,
      };
    }).sort(function (a, b) { return b.capacityKWh - a.capacityKWh; });

    return {
      targetKWh: targetKWh,
      achievedKWh: bestC / SCALE,
      totalEkPrice: lines.reduce(function (s, l) { return s + l.ekLineTotal; }, 0),
      totalVkPrice: lines.reduce(function (s, l) { return s + l.vkLineTotal; }, 0),
      lines: lines,
    };
  }

  /* Günstigste (Modell × Anzahl)-Kombination aus den Wechselrichtern, die mindestens
     targetKW AC-Leistung erreicht — analog zu findCheapestLargeTierCombo() in
     Konfigurator-Westafrika, ohne die dortige MPPT-/Modulzahl-Prüfung (die gibt es in
     MiSpeL nicht, hier zählt nur die aus den Messdaten abgeleitete PV-Spitzenleistung). */
  function chooseWechselrichterKombi(targetKW) {
    var items = byKategorie("wechselrichter");
    if (targetKW <= 0 || items.length === 0) return null;

    var best = null;
    items.forEach(function (component) {
      for (var n = 1; n <= MAX_PARALLEL; n++) {
        if (n * component.acKW < targetKW) continue;
        var extraMontageEur = (n - 1) * EXTRA_MONTAGE_PRO_ZUSATZGERAET_EUR;
        var ekTotal = n * component.ekPrice;
        var score = ekTotal + extraMontageEur;
        if (best === null || score < best.score) {
          best = { componentId: component.id, name: component.name, acKW: component.acKW, count: n, extraMontageEur: extraMontageEur, score: score, ekPriceEach: component.ekPrice };
        }
        break; // kleinstes n, das für dieses Modell reicht — mehr n macht es nur teurer
      }
    });
    if (best === null) return null;

    var ekLineTotal = best.ekPriceEach * best.count;
    var vkLineTotal = vkPrice(best.ekPriceEach) * best.count;
    return {
      targetKW: targetKW,
      achievedKW: best.acKW * best.count,
      componentId: best.componentId,
      name: best.name,
      count: best.count,
      ekPriceEach: best.ekPriceEach,
      vkPriceEach: vkPrice(best.ekPriceEach),
      extraMontageEur: best.extraMontageEur,
      totalEkPrice: ekLineTotal + best.extraMontageEur,
      totalVkPrice: vkLineTotal + best.extraMontageEur,
    };
  }

  function getDienstleistungen() {
    return byKategorie("dienstleistung");
  }

  global.MispelStueckliste = {
    STUECKLISTE: STUECKLISTE,
    MARGIN_PCT: MARGIN_PCT,
    vkPrice: vkPrice,
    chooseSpeicherKombi: chooseSpeicherKombi,
    chooseWechselrichterKombi: chooseWechselrichterKombi,
    getDienstleistungen: getDienstleistungen,
  };
})(window);
