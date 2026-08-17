# Abholtermine → CLEANILO-Kalender (Calendly)

Bestätigte Abhol-/Vor-Ort-Termine landen automatisch im CLEANILO Google Calendar.
Der Weg dorthin führt **über Calendly**, nicht über die Google-Calendar-API.

## Gewählte Route: Calendly Scheduling API

Beim Bestätigen eines Termins im Aufträge-Panel buchen wir den Slot per
`POST https://api.calendly.com/invitees` in den CLEANILO-Event-Type. Calendly
schreibt den Termin dann selbst in den verknüpften Google Calendar.

**Warum diese Route (statt direkt Google Calendar API):**

|                                                            | Calendly Scheduling API                                       | Google Calendar API direkt                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| Zugangsdaten                                               | 1 × Personal Access Token                                     | Service-Account **oder** OAuth-Client + Consent, Kalender-Freigabe    |
| Kalendereintrag                                            | Calendly schreibt ihn in den synchronisierten Google Calendar | wir schreiben ihn                                                     |
| Calendly-Verfügbarkeit wird blockiert                      | ja, systemeigen                                               | nur indirekt über die Kalender-Sync                                   |
| Erinnerungen, Absage-/Verschiebe-Links, Calendly-Workflows | inklusive                                                     | müssten wir alle selbst bauen                                         |
| Teilnehmer einladen                                        | ja                                                            | Service-Account kann ohne Domain-Wide-Delegation keine Gäste einladen |

Calendly ist ohnehin am CLEANILO-Gmail-Konto angebunden und synchronisiert
bidirektional mit dessen Google Calendar. Damit ist die Calendly-Route
schlicht die kürzere: ein Credential, kein Google-Cloud-Projekt, und wir
erben Erinnerungen und Absage-Links.

> Hinweis: Die Scheduling API (`POST /invitees`) ist neu — früher konnte man über
> die Calendly-API **keine** Buchung anlegen, nur Buchungslinks erzeugen. Sie
> setzt einen **bezahlten** Calendly-Plan voraus. Ohne bezahlten Plan bleibt nur
> die Fallback-Route unten (Buchungslink).

## Markenausnahme

Alle Buchungen laufen über **das eine CLEANILO-Calendly-Konto und dessen
Kalender — auch für Hamburg-Teppichreinigung-Aufträge**. Das ist die einzige
Stelle, an der Marken geteilt werden (bestätigt von Kabir, 06.07.2026).

Unverändert pro Marke: Auftragsbestätigung, Statusmails, Zahlungslink,
Bewertungsanfragen, Mahnungen, ✦ Claude-Nachrichten — und auch die
Terminbestätigungs- und Buchungslink-Mail. Nur die Calendly-Buchungsseite und
der Kalender sind CLEANILO.

## Flows

### 1. Operator bestätigt (Hauptweg)

```
Panel: „Termine vorschlagen" → bis zu 3 Zeiten
Panel: „Bestätigen" bei einer Zeit
  → POST /admin/orders/:id/confirm-appointment
     ├─ Auftrag: metadata.confirmedSlot + preferredDate   (immer, zuerst)
     ├─ Calendly: POST /invitees                           (CLEANILO)
     ├─ Auftrag: metadata.calendly = { status: 'booked', … }
     └─ Kunde: Terminbestätigungs-Mail (Marke des Auftrags)
Calendly → CLEANILO Google Calendar   (automatisch, Calendly-Sync)
```

Der Auftrag ist die Wahrheit. Scheitert Calendly, bleibt der Termin bestätigt
und das Panel zeigt „Nicht im CLEANILO-Kalender" plus Grund — nichts wird
zurückgerollt, damit ein Calendly-Ausfall keine Terminzusage kippt.

Erneutes Bestätigen derselben Zeit bucht nicht doppelt. Bestätigen einer
**anderen** Zeit storniert erst den alten Calendly-Termin, dann wird neu gebucht.

### 2. Kunde wählt selbst (Fallback)

```
Panel: „Kunden selbst buchen lassen"
  → POST /admin/orders/:id/pickup-booking-link
     ├─ Calendly: POST /scheduling_links  (Einmal-Link, utm_content = Auftrag)
     ├─ Auftrag: metadata.calendly = { status: 'link_sent', bookingUrl }
     └─ Kunde: „Termin auswählen"-Mail (Marke des Auftrags)
Kunde bucht → Calendly schreibt in den Google Calendar
           → Webhook invitee.created
              → metadata.confirmedSlot + preferredDate + metadata.calendly
```

Der Link wird **vor** dem Mailversand gespeichert: er ist einmalig, und ein
fehlgeschlagener Versand darf ihn nicht verbrennen. Schlägt die Mail fehl,
liefert der Endpoint 502 **mit** `bookingUrl`, und der Link steht im Auftrag
zum manuellen Verschicken.

### 3. Absage / Verschiebung

- Kunde storniert in Calendly → Webhook `invitee.canceled` → `confirmedSlot`
  wird entfernt, `metadata.calendly.status = 'cancelled'`.
- Auftrag wird bei uns storniert → der Calendly-Termin wird freigegeben, damit
  der Slot nicht weiter Verfügbarkeit blockiert und die Crew keinen Auftrag
  sieht, der nicht stattfindet.

## Zuordnung Webhook → Auftrag

Ein Konto für alle Marken heißt: die Payload allein sagt nicht, zu welchem
Mandanten eine Buchung gehört. Wir hängen deshalb an jede Buchung und jeden
Buchungslink

```
tracking.utm_content = "order:<companySlug>:<orderId>"
```

Calendly gibt das unverändert im `invitee.*`-Webhook zurück. Ohne lesbaren
Schlüssel wird das Event geloggt und ignoriert (HTTP 200 — kein Calendly-Retry
für etwas, das nie uns gehörte).

## Konfiguration

| Variable                         | Bedeutung                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CALENDLY_API_TOKEN`             | Personal Access Token des CLEANILO-Kontos. Leer ⇒ es wird nichts gebucht, alles andere funktioniert wie vorher. |
| `CALENDLY_PICKUP_EVENT_TYPE_URI` | `https://api.calendly.com/event_types/<uuid>` des Event-Types „Besichtigung / Ausführung".                      |
| `CALENDLY_WEBHOOK_SIGNING_KEY`   | Signing Key der Webhook-Subscription. Leer ⇒ der Webhook nimmt nichts an (503).                                 |
| `CALENDLY_TIMEZONE`              | Zone des Invitees, Default `Europe/Berlin`.                                                                     |
| `CALENDLY_API_BASE`              | Nur Test-Seam (lokaler Stub). In Produktion verboten, `env.ts` bricht beim Boot ab.                             |

### Einrichtung (einmalig)

```bash
# 1. Token in .env eintragen, dann prüfen, wem er gehört
node --import tsx scripts/calendly-setup.ts whoami

# 2. Event-Type-URI + location kind auslesen → in .env eintragen
node --import tsx scripts/calendly-setup.ts event-types

# 3. Webhook registrieren — gibt den Signing Key EINMAL aus
node --import tsx scripts/calendly-setup.ts webhook \
  --url https://<backend>/storefront/orders/webhook/calendly

# 4. Verfügbarkeit prüfen (beweist Token + Event-Type)
node --import tsx scripts/calendly-setup.ts available --days 7

# 5. Echte Testbuchung, danach aufräumen
node --import tsx scripts/calendly-setup.ts book --slot 2026-08-12T10:00 --email dein@name.de
node --import tsx scripts/calendly-setup.ts cancel --event <event-uri>
```

Schritt 5 legt einen **echten** Kalendereintrag an und mailt den Invitee —
eigene Adresse verwenden und hinterher stornieren.

## Zeitzonen

Slots werden überall als naive Berliner Wanduhrzeit gespeichert
(`"2026-08-12T10:00"`), Calendly will UTC mit `Z`. Die Umrechnung läuft über
`slotToUtc` / `utcToBerlinSlot` in `src/modules/orders/calendly-pickup.ts`,
beide über die Sommer-/Winterzeitgrenze getestet
(`calendly-pickup.test.ts`). Eine falsche Richtung hier bucht stillschweigend
eine Stunde daneben — daher die Round-Trip-Tests.

## Die drei Calendly-Konten (Stand 2026-08-17)

Es ist **nicht** ein Konto mit mehreren Mitgliedern, sondern drei getrennte
Organisationen mit je eigenem Token:

| Marke                    | Calendly-Slug               | Plan                                                           | Für uns nutzbar                                   |
| ------------------------ | --------------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| CLEANILO                 | `cleanilo`                  | bezahlt (Token hat `scheduled_events:write`, `webhooks:write`) | **ja — das ist das Konto, das wir nutzen**        |
| Hamburg Teppichreinigung | `teppichreinigunginhamburg` | bezahlt, gleiche Scopes                                        | ungenutzt (Markenausnahme: HTR bucht in CLEANILO) |
| Morgenland Teppiche      | `morgenland-teppiche`       | Free — Token ist **read-only**                                 | nein, kann nicht buchen                           |

Weil es getrennte Organisationen sind, kann der CLEANILO-Token nur in
CLEANILO-Event-Types buchen. Das deckt sich mit Kabirs Regel und ist der Grund,
warum ein Token genügt. Sollen HTR-Abholungen später doch im HTR-Kalender
landen, braucht es pro Marke ein Token/Event-Type-Paar in der Config — die
Markenausnahme wäre dann hinfällig. Entscheidung liegt bei Kabir.

Der Event-Type, den wir buchen:
`Besichtigung/Ausführung`, 60 Min, Location-Kind `physical`,
`https://calendly.com/cleanilo/besichtigung-ausfuehrung`.

## Fallstricke, die erst der Live-Call gezeigt hat

Alles hier ist gegen das echte Konto verifiziert, nicht aus der Doku geraten:

1. **`tracking` ist alles oder nichts.** Sobald das Objekt mitgeschickt wird,
   müssen _alle sechs_ Felder da sein (`utm_source`, `utm_medium`,
   `utm_campaign`, `utm_content`, `utm_term`, `salesforce_uuid`), sonst 400
   „is missing". Wir füllen die ungenutzten mit `""`.
2. **Die Location-Adresse gehört dem Event-Type.** Bei `physical` muss exakt der
   im Event-Type hinterlegte Text zurückgeschickt werden; die Kundenadresse dort
   einzusetzen ist „invalid location choice". Die Kundenadresse gehört in die
   Adress-Frage, nicht in die Location.
3. **Pflicht-Fragen blockieren die Buchung.** Der CLEANILO-Event-Type hat drei
   `required` Custom Questions (Telefon, Freitext-Briefing, Adresse). Fehlt eine
   Antwort, ist die Buchung ein hartes 400. Wir lesen die Fragen deshalb per
   `getPickupEventType()` (10 Min Cache) und beantworten sie aus dem Auftrag —
   so überlebt die Integration ein Umformulieren im Calendly-UI.
4. **Ein belegter Slot ist ein 400, kein 409.** Calendly antwortet
   `event.start_time — „Diese Startzeit wurde eingetragen"`. `isSlotUnavailable`
   prüft deshalb den Parameternamen mit; sonst liest sich ein voller Kalender
   für den Operator wie ein Ausfall.

## Was noch offen ist

- **Deployment:** Der Webhook ist auf
  `https://api.reinigungs-portal.com/storefront/orders/webhook/calendly`
  registriert (organization-scope, `invitee.created` + `invitee.canceled`,
  Subscription `198a3e13-21d1-4d80-b7a1-38bc3bc64551`). Der Endpoint ist erst
  nach dem nächsten Deploy erreichbar — bis dahin laufen Webhook-Zustellungen in
  Calendlys Retry. Nach dem Deploy einmal selbst buchen und prüfen, dass der
  Termin am Auftrag ankommt.
- **Webhook-Signaturformat** ist der einzige ungeprüfte Punkt: Calendly
  dokumentiert `t=…,v1=…` (HMAC über `<t>.<body>`), es gibt Berichte über den
  reinen Hex-Digest. `verifyCalendlyWebhook` akzeptiert beide — beide verlangen
  eine gültige HMAC unter dem Signing Key, die Duldung kostet also keine
  Sicherheit. Nach dem ersten echten Webhook im Log nachsehen und die andere
  Form entfernen.
- **Absturzfenster:** Stirbt der Prozess zwischen `POST /invitees` und dem
  Metadata-Write, existiert ein Calendly-Termin, von dem der Auftrag nichts
  weiß; das Panel zeigt „Nicht im CLEANILO-Kalender", und ein erneutes
  Bestätigen derselben Zeit scheitert an genau diesem Waisen-Termin. Beim
  Live-Test einmal passiert (Dev-Server-Neustart mitten im Request). Aufräumen
  von Hand über `scripts/calendly-setup.ts cancel --event <uri>`; eine
  automatische Reconciliation wäre erst nötig, wenn das öfter vorkommt.
