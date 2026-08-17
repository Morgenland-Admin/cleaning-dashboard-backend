# HTR-Kategorieseiten im seo-pages-System (SEO-Autopilot)

Die Kategorieseiten der Hauptdomain hamburg-teppichreinigung.de
(`/leistungen/<slug>/`) liegen als Zeilen in `hamburg_teppichreinigung.seo_pages`
und sind über die bestehende API les- und patchbar:

- `GET /admin/seo-pages?category=leistung` (Liste), `GET /admin/seo-pages/:id`
- `PATCH /admin/seo-pages/:id`
- öffentlich (vom Storefront genutzt): `GET /storefront/seo/leistungen/<slug>`

Die Seite selbst bleibt eine feste Next-Route mit festem Layout. Die Zeile ist
ein **Overlay**: sie liefert die SEO-relevanten Texte, alles andere kommt
weiterhin aus dem Template `src/lib/leistungen-content.ts`.

## Bestand

| id  | path                                | Seite                               |
| --- | ----------------------------------- | ----------------------------------- |
| 1   | `leistungen/teppichreinigung`       | /leistungen/teppichreinigung/       |
| 2   | `leistungen/teppichbodenreinigung`  | /leistungen/teppichbodenreinigung/  |
| 3   | `leistungen/fleckenentfernung`      | /leistungen/fleckenentfernung/      |
| 4   | `leistungen/teppichreparatur`       | /leistungen/teppichreparatur/       |
| 5   | `leistungen/mottenbekampfung`       | /leistungen/mottenbekampfung/       |
| 6   | `leistungen/geruchsneutralisierung` | /leistungen/geruchsneutralisierung/ |
| 7   | `leistungen/polsterreinigung`       | /leistungen/polsterreinigung/       |

Alle: `type=service`, `category=leistung`, `status=live`,
`source=htr-category-import`, `city/region=Hamburg`.
(ids gelten für die lokale DB; in Prod vergibt der Import eigene ids.)

Seed / Re-Seed aus dem Template:

```bash
node --import tsx scripts/import-htr-category-pages.ts --dry-run
node --import tsx scripts/import-htr-category-pages.ts            # legt fehlende Zeilen an
node --import tsx scripts/import-htr-category-pages.ts --overwrite # setzt auf Template zurück
```

Bestehende Zeilen werden ohne `--overwrite` nie angefasst — ein zweiter Lauf
kann keine Autopilot-Änderung überschreiben.

## Feldkarte — eigenes Feld vs. in bodyHtml eingebettet

Gilt für alle drei Marken, weil `seo_pages` in jedem Tenant-Schema identisch ist.

| Feld            | Spalte             | eigenes Feld?                     | HTR-Kategorieseite: Wirkung                                                     |
| --------------- | ------------------ | --------------------------------- | ------------------------------------------------------------------------------- |
| metaTitle       | `meta_title`       | ja                                | `<title>` + og:title                                                            |
| metaDescription | `meta_description` | ja                                | `<meta name="description">` + og:description                                    |
| h1              | `h1`               | ja                                | H1 der Seite; `*…*` markiert die farbig hervorgehobene Hälfte                   |
| title           | `title`            | ja                                | Überschrift des SEO-Textblocks („Über unseren Service"), `*…*` = Highlight      |
| bodyHtml        | `body_html`        | ja                                | Fließtext des SEO-Blocks; erster Block sichtbar, Rest hinter „Mehr lesen"       |
| FAQ             | `faq` (jsonb)      | ja, **nicht** in bodyHtml         | FAQ-Akkordeon **und** FAQPage-JSON-LD (aus denselben Daten)                     |
| JSON-LD         | `schema_jsonld`    | ja, **nicht** in bodyHtml         | zusätzliche Blöcke, ergänzend zu den generierten (Breadcrumb, Service, FAQPage) |
| interne Links   | —                  | **eingebettet in bodyHtml**       | normale `<a href="/leistungen/…/">`; bleiben dofollow                           |
| Bilder          | —                  | eingebettet (`<img>` in bodyHtml) | Hero-/Galeriebilder selbst sind Template, nicht patchbar                        |
| status          | `status`           | ja                                | `draft` = Overlay aus (Template greift), `live`/`protected` = an                |
| gscPosition     | `gsc_position`     | ja                                | ≤ 5 ⇒ Schutz greift, siehe unten                                                |

Andere Marken: CLEANILO und TRL nutzen `seo_pages` bisher nur für die
`/seo/<path>`-Landingpages und `type=blog`; deren Leistungsseiten sind komplett
hartkodiert und haben keine Overlay-Zeilen. Die Feldbedeutung dort:
bodyHtml ist der **ganze** Seiteninhalt, `h1`/`title` die Überschrift,
FAQ und JSON-LD ebenfalls eigene Felder.

## Hartkodiert vs. patchbar (HTR-Kategorieseiten)

**Patchbar über die API:** metaTitle, metaDescription, H1, Überschrift und
Fließtext des SEO-Blocks, FAQ (Text + JSON-LD), zusätzliche JSON-LD-Blöcke.

**Hartkodiert im Template** (`leistungen-content.ts` / `leistung-shell.tsx`),
nur per Deploy änderbar: Eyebrow, Lede, Hero-Bild, USP-Kacheln, Verfahren-Blöcke,
Preistabelle inkl. Offer-JSON-LD, Ablauf-Schritte, Vorher/Nachher-Galerie,
Buchungs-/Anfrage-CTAs, Breadcrumb- und Service-JSON-LD, Navigation.

Fällt das Backend aus oder steht die Zeile auf `draft`, rendert die Seite
vollständig aus dem Template — verifiziert, Text identisch.

## Versionshistorie / Rollback

**Nein.** `PATCH` überschreibt die Zeile in-place; es gibt keine Versionstabelle,
kein Audit-Log für `seo_pages` und damit keinen Rollback. Erhalten bleibt nur
`updated_at`. Was es stattdessen gibt:

1. **Schutzregel:** Bei `status=protected` **oder** `gsc_position <= 5` weist
   `PATCH` jede inhaltliche Änderung mit **409 `PROTECTED`** ab; nur
   `status`, `gscPosition` und `source` gehen noch durch. Verifiziert.
   → Achtung für den Autopiloten: sobald er echte GSC-Positionen in
   `gscPosition` schreibt, sperren sich die Top-5-Seiten selbst.
2. **Re-Seed:** `scripts/import-htr-category-pages.ts --overwrite` stellt den
   Stand des Templates wieder her — das ist der einzige „Rollback", und er geht
   nur auf den Auslieferungsstand zurück, nicht auf eine frühere Autopilot-Version.

Wenn echte Historie gewünscht ist: eigene Tabelle `seo_page_revisions`
(page_id, snapshot jsonb, changed_by, changed_at), beim PATCH den Vorzustand
wegschreiben. Nicht gebaut, wäre ein eigener Task.

## Betriebshinweise

- **Übernahme auf der Website:** bis zu **1 Stunde**. Der Storefront-Fetch läuft
  mit `next: { revalidate: 3600 }` — gleiches Verhalten wie /seo-Seiten und Blog.
  Kein Deploy nötig.
- **Keine Doppel-URLs:** Overlay-Zeilen (`category=leistung`) sind aus
  `GET /storefront/seo/` und aus `/storefront/seo/sitemap.xml` ausgeschlossen und
  werden auf dem Storefront von `/seo/leistungen/<slug>` per 308 auf die
  kanonische URL `/leistungen/<slug>/` umgeleitet. Im Next-Sitemap stehen die
  Seiten genau einmal, unter ihrer echten URL.
- **Sanitizer:** `bodyHtml` läuft durch die Allowlist (`src/lib/sanitize-html.ts`);
  `<script>` & Co. werden verworfen. Interne Links (`/…`) behalten dofollow,
  nur externe Links bekommen `rel="noopener noreferrer nofollow"`.
- **Rechte:** Lesen ab `viewer`, `PATCH` ab `manager` (`requireAccess`).
- **Dashboard-UI:** Das Admin-Dashboard zeigt `seo_pages` bisher nur als
  Blog-Ansicht (`type=blog`). Die Kategorieseiten sind dort nicht sichtbar —
  Bearbeitung läuft über die API bzw. den Autopiloten.
