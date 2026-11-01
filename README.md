# Værelset

En altid tændt hjemmeskærm til en iPad 6 på værelset: ur, vejr, styring af Spotify, huskeliste, vækkeur og natfunktion. Lyden går fra iPad'en gennem jackkablet til Libratone-højttaleren.

Det er en almindelig webside uden byggetrin. Alle personlige data ligger på iPad'en. Designet står i [designdokumentet](docs/superpowers/specs/2026-11-01-home-screen-design.md).

## Det, der mangler

Funktionerne er bygget. Disse trin kræver dig:

### 1. Vælg et design

Udseendet er neutralt og midlertidigt. Når du har valgt en retning, skal der kun ændres i `style.css` og i listen `THEMES` i `js/theme.js`. Resten af siden påvirkes ikke.

### 2. Læg siden på nettet

Spotify kræver en HTTPS-adresse til login. GitHub Pages er gratis:

1. Opret en konto på github.com, og lav et offentligt repository, for eksempel `vaerelset`.
2. Læg indholdet af denne mappe op.
3. Slå Pages til under **Settings → Pages**, med grenen `main` og mappen `/ (root)`.

Adressen bliver `https://DITNAVN.github.io/vaerelset/`.

### 3. Opret Spotify-appen

1. Log ind på [Spotifys udviklerside](https://developer.spotify.com/dashboard) med din Premium-konto, og vælg **Create app**.
2. Skriv adressen fra trin 2 under **Redirect URIs**. Den skal være helt ens, også skråstregen til sidst.
3. Vælg **Web API**, og gem.
4. Kopiér **Client ID**. Der er ingen hemmelig nøgle, og du skal ikke bruge **Client secret**.

### 4. Sæt iPad'en op

1. Åbn adressen i Safari, og vælg **Del → Føj til hjemmeskærm**.
2. Åbn **Værelset** fra hjemmeskærmen.
3. Tryk på tandhjulet, skriv din by og dit klient-id, og tryk **Log ind**.
4. Sæt **Indstillinger → Skærm og lysstyrke → Autolås** til **Aldrig**, og lad opladeren sidde i.
5. Sæt jackkablet direkte i iPad'en, og start Spotify-appen.

**Hvis login ikke kommer tilbage til appen:** Log ind i Safari i stedet. Åbn indstillingerne der, tryk **Vis loginkode**, kopiér koden, indsæt den i hjemmeskærms-appen, og tryk **Brug loginkode**. Hold koden for dig selv, for den giver adgang til din Spotify.

### 5. Test på den rigtige iPad

Følgende kan ikke testes uden iPad'en og din Spotify-konto:

- [ ] Login virker fra hjemmeskærms-appen, eller med loginkoden
- [ ] Musik starter og kommer ud af højttaleren gennem kablet
- [ ] Knapperne virker, mens Spotify-appen ligger i baggrunden
- [ ] Knappen **Åbn Spotify** åbner appen
- [ ] Et eget baggrundsbillede kan vælges fra Billeder
- [ ] Vækkeuret starter musikken med tændt skærm
- [ ] Alarmlyden virker, når Spotify er lukket
- [ ] Siden kører en hel nat uden at gå i stå

Vækkeuret må ikke være din eneste vækning, før det har virket nogle morgener i træk.

## Kendte begrænsninger

- Lydstyrken styres med knapperne på iPad'en eller højttaleren.
- iOS kan lukke Spotify-appen, når musikken har været sat på pause længe. Så skal den åbnes igen.
- Natfunktionen gør kun indholdet mørkt. iPad'ens rigtige lysstyrke kan en webside ikke ændre.
- Musikdelen kræver, at dit Premium-abonnement er aktivt. Resten virker uden.

## Tests

Testene kører i en browser og kræver kun Windows. Start serveren fra denne mappe:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File tests/serve.ps1
```

| Adresse | Indhold |
|---|---|
| http://localhost:8123/tests/index.html | Logik og simuleringer |
| http://localhost:8123/tests/e2e.html | Hele siden mod en falsk Spotify. Resultatet står i fanens titel |

Sidetesten af layoutet forudsætter et vindue på 1024 × 768.

Fejltesten lægger fejl ind i koden, én ad gangen og kun i hukommelsen, og viser, om testene opdager dem:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File tests/mutate-server.ps1
```

Åbn derefter http://localhost:8124/tests/mutation.html.
