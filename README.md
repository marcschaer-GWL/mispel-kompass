# MiSpeL-Kompass

Kunden-Erklär- und Rechen-Tool zur MiSpeL-Regelung (Marktintegration von Speichern und
Ladepunkten). Einzelne, in sich geschlossene Web-Seite ohne Build-Schritt — direkt per
Doppelklick auf [`mispel-kompass.html`](mispel-kompass.html) im Browser lauffähig.

## Struktur

```
MiSpeL/
├── mispel-kompass.html      Einstiegsdatei: nur Markup, bindet css/ und js/ ein
├── css/
│   ├── tokens.css           GWL-Markenfarben & Typografie als CSS-Variablen
│   └── styles.css           Komponenten- und Layout-Styles (nutzt nur Tokens aus tokens.css)
├── js/
│   └── kompass.js           Tab-Umschaltung, Modellrechnung, Rendering (Module 03/04)
├── assets/
│   └── fonts/
│       └── inter-variable-latin.woff2   selbst gehostete Schrift, keine Font-CDN-Requests
└── design/
    ├── GWL-Design-Guidelines.md         Zusammenfassung der Vorgaben + Mapping-Entscheidungen
    ├── GWL_Design_Frontend_Guidelines.pdf
    ├── frontend-designvorgaben.agent.md
    ├── theme.reference.ts
    └── Projektvorgaben.md               Inhaltliche/funktionale Vorgaben (z. B. Ja/Nein-Fragen)
```

## Warum diese Aufteilung

Vorher war alles (Tokens, Komponenten-CSS, Rendering-Logik, Markup) in einer 800-Zeilen-Datei.
Jetzt lässt sich gezielt ändern:

- **Farben/Schrift anpassen** → nur `css/tokens.css`
- **Aussehen einer Komponente ändern** (Karte, Badge, Balkendiagramm, …) → nur `css/styles.css`
- **Rechenlogik oder Rendering ändern** (Modul 03/04) → nur `js/kompass.js`
- **Text/Inhalt ändern** (Module 01–04, Quellenliste) → nur `mispel-kompass.html`

Das Design selbst ist auf das verbindliche GWL-Markendesign umgestellt (dunkles Theme, Gold-
Akzent, Inter, Pill-Badges in Großbuchstaben) — Details und Herkunft der Vorgaben stehen in
[`design/GWL-Design-Guidelines.md`](design/GWL-Design-Guidelines.md).

## Design-Vorgaben aktuell halten

Die Dateien in `design/` sind Kopien aus dem Projekt `Konfigurator-Westafrika` (Stand
2026-08-21). Ändern sich die Vorgaben dort (`.claude/agents/frontentdesign vorgaben.agent.md`,
`packages/frontend/src/styles/theme.ts`, `GWL_Design_Frontend_Guidelines.pdf`), sollten die
Kopien hier und die Umsetzung in `css/tokens.css` bei Bedarf nachgezogen werden.
