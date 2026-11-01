# Home screen til iPad på værelset: design

Dato: 2026-11-01

## Mål

En iPad 6. generation (iPadOS 17.7) står fast på værelset og fungerer som en altid tændt skærm. Den viser ur, dato og vejr, styrer musikken og har huskeliste, vækkeur og natfunktion. Udseendet kan man selv vælge.

Det er færdigt, når ejeren kan se tid og vejr på afstand, starte en af sine Spotify-playlister med få tryk, og musikken kommer ud af Libratone-højttaleren.

## Forudsætninger

- Lyden går fra iPad'en til Libratone-højttaleren gennem et jackkabel. iPad 6 har selv et jackstik, så omformeren er sandsynligvis overflødig.
- Spotify-appen på iPad'en afspiller musikken. Ejeren har Spotify Premium.
- Hjemmeskærmen taler kun med Spotify og aldrig direkte med højttaleren.
- Der udvikles på Windows, og der er ingen Mac. Derfor bliver det en webside, der lægges på iPad'ens hjemmeskærm, og ikke en app fra App Store.

## Opbygning

En statisk webside med almindelig HTML, CSS og JavaScript, uden byggetrin og uden egen server. Den ligger gratis på GitHub Pages, fordi Spotify kræver en HTTPS-adresse til login. Alle personlige data ligger på iPad'en.

| Del | Fil | Ansvar |
|---|---|---|
| Side | `index.html`, `style.css` | Layout og temaer |
| Opstart | `js/app.js` | Starter delene og binder dem til siden |
| Ur | `js/clock.js` | Tid og dato på dansk |
| Vejr | `js/weather.js` | Henter og viser vejr fra Open-Meteo |
| Spotify | `js/spotify.js` | Login, afspilning og playlister |
| Vækkeur | `js/alarm.js` | Finder tidspunktet og starter musikken |
| Huskeliste | `js/todo.js` | Tilføj, afkryds og slet |
| Temaer | `js/theme.js` | Valg af tema, eget billede og natfunktion |
| Lager | `js/storage.js` | Samlet adgang til gemte data |
| Indstillinger | `js/settings.js` | Læser indstillinger og retter ugyldige værdier |
| Net | `js/http.js` | Kald med tidsgrænse |
| Alarmlyd | `js/sound.js` | Bip, når Spotify ikke kan starte |
| Installation | `manifest.json`, ikon | Gør at siden åbner som en app |
| Offline | `sw.js` | Gemmer sidens filer, så uret virker uden net |

## Skærmen

iPad'en står på langs.

- **Venstre side:** stort ur og dato øverst, vejret lige nu og den kommende tid i midten, huskelisten nederst.
- **Højre side:** cover, sang og kunstner, knapper til forrige, afspil/pause og næste, og derunder listen med playlister.
- **Øverste linje:** dato, næste vækning, natfunktion og indstillinger.

Siden skal kunne bruges på langs. Teksten skal være stor nok til at læse på afstand, og knapper skal være store nok til at ramme uden at se efter.

## Funktioner

### Musik

- Login sker med Spotifys PKCE-flow, som ikke kræver en hemmelig nøgle. Ejeren opretter selv en gratis Spotify-udviklerapp og indtaster dens klient-id i indstillingerne.
- Rettigheder: `user-read-playback-state`, `user-modify-playback-state`, `playlist-read-private`, `playlist-read-collaborative`.
- Bruger disse kald: `GET /me/player`, `GET /me/player/devices`, `PUT /me/player`, `PUT /me/player/play`, `PUT /me/player/pause`, `POST /me/player/next`, `POST /me/player/previous`, `GET /me/playlists`.
- Playlister startes ved at sende playlistens adresse som `context_uri`. Kun listen over playlister og deres navne bruges, så det er ikke et problem, at Spotify ikke længere udleverer indholdet af andres playlister.
- Afspilningsstatus hentes hvert 5. sekund, mens siden er åben.
- **Lydstyrke:** Der er ingen lydstyrkeknap. Den styres med knapperne på iPad'en eller højttaleren.

### Vejr

Data kommer fra Open-Meteo, som er gratis og uden konto. Ejeren skriver sin by i indstillingerne, og den slås op med Open-Meteos søgefunktion. Vejret opdateres hvert 15. minut og viser temperatur, vejrtype, de næste timer og de næste dage.

### Vækkeur

Ejeren vælger et tidspunkt, ugedage og en playliste. På tidspunktet startes playlisten via Spotify.

Det virker kun, når siden står åben på skærmen, og Spotify-appen stadig er i gang. Hvis Spotify ikke svarer, blinker skærmen tydeligt, og siden forsøger at afspille en alarmlyd. iOS kan blokere lyd, der ikke er startet af et tryk, så det skal testes. Vækkeuret må ikke være den eneste måde at vågne på, før det har virket pålideligt nogle morgener i træk.

### Huskeliste

Man kan tilføje, afkrydse og slette punkter. Listen gemmes på iPad'en. Der er ingen synkronisering med andre enheder.

### Temaer

**Det visuelle design er ikke besluttet.** De fire første forslag (Nattehimmel, Solnedgang, Neon, Skov) er fravalgt. Indtil ejeren har valgt en retning, findes kun et neutralt, midlertidigt tema. Temaer er samlet i en liste og sat op med CSS-variabler, så nye kan tilføjes uden at ændre resten af siden.

Ejeren kan vælge sit eget billede som baggrund. Et eget billede vælges fra iPad'ens billeder, skaleres ned og gemmes lokalt. Det får et mørkt lag over sig, så teksten altid kan læses.

### Natfunktion

Natfunktionen starter automatisk i et valgt tidsrum (standard 22:00-07:00) eller med månen på skærmen. Skærmen bliver næsten sort med et svagt rødligt ur og vejret skjult. En webside kan ikke ændre iPad'ens rigtige lysstyrke, så skærmen bliver kun mørkere ved at vise mørkt indhold. Et tryk på skærmen viser kontrollerne igen et øjeblik.

## Fejl

Ingen fejl må få hele siden til at gå i stå. Uret virker altid, også uden internet.

| Situation | Hvad skærmen gør |
|---|---|
| Ingen forbindelse til nettet | Viser seneste vejr med tidspunkt og forsøger igen senere |
| Spotify-appen er lukket (ingen enhed fundet) | Viser knappen "Åbn Spotify", som åbner appen |
| Login er udløbet | Fornyer det automatisk og beder kun om nyt login, hvis det mislykkes |
| Spotify-kaldet afvises eller der er for mange kald | Viser en kort besked og venter med næste forsøg |
| Eget billede er for stort til at gemme | Viser en besked og beholder det tidligere tema |

## Risici, der testes først

1. **Login i hjemmeskærms-appen.** iOS adskiller en hjemmeskærms-app fra Safari, så turen til Spotifys login og tilbage kan gå galt. Det testes på iPad'en som det allerførste. Hvis det fejler, logger man ind i Safari og overfører login til appen med en engangskode, som man indsætter.
2. **Spotify i baggrunden.** iOS kan lukke Spotify-appen, når den har været sat på pause længe. Så kan skærmen ikke styre den, før den er åbnet igen. Det kan ikke løses fra en webside, kun afhjælpes med knappen "Åbn Spotify".
3. **Skærmen slukker.** En webside kan ikke holde skærmen tændt pålideligt som hjemmeskærms-app på iPadOS 17. Ejeren sætter Autolås til Aldrig og har opladeren i.
4. **Spotifys regler.** Udviklerapps kræver, at ejeren har Premium. Stopper abonnementet, holder musikdelen op med at virke, mens resten fortsætter. Reglerne er tjekket mod Spotifys migreringsguide fra februar 2026.

## Test

Testene kører i en browser, så projektet ikke kræver andet end Windows. Se `README.md` for, hvordan de startes.

- Ren logik (vækketidspunkt, natfunktionens tidsrum, oversættelse af vejrkoder, lagring) og simuleringer af lange forløb får automatiske tests.
- Hele siden testes mod en falsk version af Spotify og vejr-API'et, herunder fejlene fra tabellen.
- En fejltest lægger fejl ind i koden og tjekker, at testene opdager dem.
- Til sidst køres testlisten i `README.md` på den rigtige iPad: installation, login, afspilning gennem kablet, playlistevalg, vækkeur med tændt skærm, natfunktion og en hel nat tændt.

## Ikke med i første version

- Lydstyrke fra skærmen
- Apple Music og netradio
- Kalender
- Synkronisering med andre enheder
- Styring af lys og andet i hjemmet
- Understøttelse af iPad'en på højkant
