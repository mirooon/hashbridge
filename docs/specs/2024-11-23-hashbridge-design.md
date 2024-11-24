# Hashbridge: projekt aplikacji

Atomic swap BTC → SUI bez zaufania do pośrednika: HTLC na Bitcoinie (UTXO) i HTLC w Move na Sui, połączone tym samym sekretem SHA-256.

## 1. Cel i zakres

**Kontekst:** projekt na hackathon, jedna osoba, weekend (~48 h).

**Sukces:** na scenie przechodzi pełny swap w około minutę. Obie transakcje widać w publicznych explorerach (mempool.space/signet, Suiscan). Ścieżkę zwrotu da się pokazać albo opisać.

**Ustalenia:**
- Kierunek: użytkownik wpłaca BTC (signet), dostaje SUI (testnet).
- Kontrahent: nasz bot-resolver, który automatycznie dostarcza drugą stronę swapu.
- Sieć BTC: signet. Bot reaguje na transakcję w mempoolu (`MIN_CONF=0` w demo, konfigurowalne).
- Wpłata BTC: adres HTLC + QR, płatność z dowolnego portfela signet. Klucz zwrotu generuje przeglądarka.
- Bot dowiaduje się o swapie przez rejestrację w swoim API (`POST /swaps`).
- UI po angielsku.

**Poza zakresem:** SUI → BTC, swap P2P, integracja portfeli BTC w przeglądarce, mainnet, wielu resolverów, zewnętrzne wyrocznie cenowe.

## 2. Przepływ swapu

```
Użytkownik (przeglądarka)        Bot                      Bitcoin signet        Sui testnet
1. generuje sekret S (32 B), H=sha256(S),
   klucz zwrotu k_u
2. POST /swaps {H, pub_u, adres Sui, kwota} ──►
                       ◄── wycena, pub_bota, locktime BTC, adres HTLC
   przelicza adres HTLC lokalnie
   i sprawdza, czy zgadza się z adresem bota
3. płaci BTC na adres HTLC ─────────────────────────────►  tx w mempoolu
                                   4. widzi tx (MIN_CONF) ◄──
                                      htlc::lock(SUI, H, termin) ─────────────►  Htlc
5. odczytuje obiekt Htlc z RPC Sui i weryfikuje go
   wysyła S → bot robi claim w jego imieniu ──────────────────────────────────►  SUI do użytkownika
                                   6. odczytuje S z eventu Claimed
                                      wydaje HTLC BTC przez (sig_bota, S) ──►  BTC do bota
```

**Odbiór SUI bez gasu.** Użytkownik wysyła S do bota (`POST /swaps/:id/claim`), a bot wywołuje `htlc::claim`. Kontrakt zawsze wysyła środki do `recipient`, więc bot nie może ich przekierować. Użytkownik nie potrzebuje portfela Sui, wystarczy adres. Jeśli claim nie pojawi się na łańcuchu w ciągu 30 s, UI pokazuje „Claim myself” (portfel z gasem, opcjonalne).

**Weryfikacja przed ujawnieniem S.** Przeglądarka odczytuje obiekt `Htlc` bezpośrednio z RPC Sui i sprawdza: typ obiektu == `<HTLC_PACKAGE_ID>::htlc::Htlc<0x2::sui::SUI>` (`VITE_HTLC_PACKAGE_ID`, żeby bot nie podsunął obiektu z innego pakietu), `recipient` == adres użytkownika, `hash` == H, kwota ≥ wycena proporcjonalna do faktycznej wpłaty, do terminu zostało co najmniej 10 min. Statusowi z API bota nie ufa.

### Skrypt BTC (P2WSH)

```
OP_IF
    OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <pub_bota>
OP_ELSE
    <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pub_u>
OP_ENDIF
OP_CHECKSIG
```

- Witness claim: `[sig_bota, S, 0x01, witnessScript]`.
- Witness refund: `[sig_u, <pusty>, witnessScript]`, `nLockTime = locktime`, `nSequence < 0xffffffff`.
- `locktime` to bezwzględna wysokość bloku.

### Terminy

- Locktime BTC = wysokość bloku przy rejestracji + `BTC_LOCKTIME_BLOCKS` (domyślnie 72, ~12 h).
- Termin Sui = chwila blokady + `SUI_TIMEOUT_MS` (domyślnie 1 h).
- Termin na Sui musi zawsze wypadać dużo wcześniej niż locktime BTC. Bot blokuje SUI tylko wtedy, gdy `tip + SAFETY_BLOCKS < locktime` (domyślnie `SAFETY_BLOCKS=12`).

### Zwroty

- Bot nie zablokował SUI → po locktime przeglądarka podpisuje refund kluczem k_u na adres BTC podany przez użytkownika. Refund wydaje wszystkie UTXO z adresu HTLC.
- Bot zablokował SUI, nikt nie zrobił claim → po terminie bot wywołuje `htlc::refund`.

### Zmiana w kontrakcie

`htlc::claim` wymaga, żeby preimage miał dokładnie 32 bajty (nowy kod błędu `EBadPreimageLength`), tak jak `OP_SIZE 32` w skrypcie BTC. Bez tego sekret dłuższy niż 520 bajtów przeszedłby na Sui, ale nie dałoby się go użyć na Bitcoinie, i bot straciłby BTC.

### Świadomie przyjęte ryzyko

Przy `MIN_CONF=0` użytkownik może podmienić transakcję wpłaty przez RBF już po blokadzie SUI. Akceptowalne w demo. Poza sceną `MIN_CONF ≥ 1`.

## 3. UI

Jedna strona z krokami. Adres `#/swap/:id` (routing po hashu, działa na statycznym hostingu), stan swapu w localStorage (wznawianie po odświeżeniu).

1. **Formularz.** Kwota BTC, orientacyjna kwota SUI z kursu z `GET /health` (odświeżany co 30 s, z odliczaniem do odświeżenia), pole na adres Sui albo „Connect wallet” (dapp-kit), przycisk „Start swap”. Wiążąca wycena powstaje przy `POST /swaps`, a jej ważność odlicza ekran wpłaty.
2. **Plik odzyskiwania.** Pobranie JSON z S, k_u i parametrami swapu (`swapId`, H, `pub_bota`, `pub_u`, `locktime`, `witnessScript`, `htlcAddress`, adres Sui). „Next” odblokowuje się dopiero po pobraniu.
3. **Wpłata.** QR (`bitcoin:<adres>?amount=<btc>`), adres i kwota z kopiowaniem, status „Waiting for deposit…”, przełącznik „Show HTLC script”.
4. **Oś czasu na żywo.** Dwie kolumny (Bitcoin | Sui). Kroki: wpłata w mempoolu, SUI zablokowane, sekret ujawniony i SUI odebrane, bot odebrał BTC. Każdy krok ma link do explorera. Na dole odliczanie do locktime BTC i terminu Sui.
5. **Gotowe.** Otrzymana kwota SUI, linki do obu transakcji, jedno zdanie o atomowości.

**Stany awaryjne:**
- Swap `REJECTED` albo bot nie zablokował SUI w ciągu 10 min → ekran zwrotu: pole na adres BTC, odliczanie bloków do locktime, przycisk „Refund BTC”, aktywny od locktime.
- Brak claim na łańcuchu 30 s po wysłaniu S → „Claim myself”.
- Ekran startowy: „Import recovery file” wznawia dowolny swap.

## 4. Bot-resolver

Jeden proces Node ≥ 22.13 / TypeScript: API (Hono), pętle obserwujące łańcuchy (co 3 s), stan w SQLite (wbudowany moduł `node:sqlite`, bez natywnych zależności).

### API

| Endpoint | Działanie |
|---|---|
| `POST /swaps {hash, refundPubkey, suiRecipient, btcSats}` | Zwraca `{swapId, botPubkey, locktime, htlcAddress, witnessScript, suiAmount, quoteExpiresAt}`. Odmawia, gdy kwota jest poza `[MIN_BTC_SATS, MAX_BTC_SATS]` albo saldo SUI jest za małe. |
| `GET /swaps/:id` | Status, kwoty, digesty i txid z linkami do explorerów. Frontend odpytuje co 2 s. |
| `POST /swaps/:id/claim {preimage}` | Sprawdza `sha256(preimage) == H` i długość 32 B, wywołuje `htlc::claim`. |
| `GET /health` | Salda BTC i SUI, wysokość bloku signet, `pub_bota`, adres Sui bota, kurs, spread i limity kwot (formularz liczy z nich orientacyjną kwotę). |

**Wycena:** `suiAmount = btcSats × RATE × (1 − SPREAD_BPS/10000)`, ważna `QUOTE_TTL_S` (domyślnie 60 s).

### Pętle

1. **Wpłaty BTC.** Dla swapów `AWAITING_DEPOSIT` bot pyta Esplorę (`https://mempool.space/signet/api/address/:addr/utxo`). Gdy znajdzie UTXO z co najmniej `MIN_CONF` potwierdzeniami → `DEPOSIT_SEEN`. Następnie sprawdza: wycena nie wygasła w chwili pierwszego zobaczenia wpłaty, kwota ≥ `MIN_BTC_SATS`, `tip + SAFETY_BLOCKS < locktime`, saldo SUI wystarcza. Kwota SUI liczona jest od faktycznej wpłaty (do `MAX_BTC_SATS`). Jeśli którykolwiek warunek nie przejdzie → `REJECTED`. Swapy bez wpłaty po locktime → `EXPIRED`.
2. **Blokada SUI.** Jedna transakcja: `splitCoins(gas, [kwota])` → `htlc::lock(coin, recipient, H, now + SUI_TIMEOUT_MS, clock)` → `SUI_LOCKED`, zapis `htlcObjectId`.
3. **Claim na Sui.** Bot wykrywa claim po evencie `Claimed` z `htlc_id` albo po własnym claim w imieniu użytkownika → `SUI_CLAIMED`. Następnie buduje tx claim BTC na swój adres i wysyła przez `POST /api/tx` → `BTC_CLAIMED`.
4. **Zwrot SUI.** `SUI_LOCKED` po terminie bez claim → `htlc::refund` → `SUI_REFUNDED`.

### Stany

```
AWAITING_DEPOSIT → DEPOSIT_SEEN → SUI_LOCKED → SUI_CLAIMED → BTC_CLAIMED
       ↘ EXPIRED         ↘ REJECTED      ↘ SUI_REFUNDED
```

Stany końcowe: `BTC_CLAIMED`, `EXPIRED`, `REJECTED`, `SUI_REFUNDED`.

### Odporność na restart

Po starcie bot wznawia wszystkie swapy, które nie są w stanie końcowym. Transakcja Sui jest najpierw podpisywana, digest zapisywany w bazie, dopiero potem wysyłana. Po restarcie bot sprawdza zapisany digest w RPC zamiast podpisywać nową transakcję, żeby nie zablokować SUI podwójnie. Claim BTC jest bezpieczny do powtórzenia (drugie wysłanie tego samego wydatku zostanie odrzucone).

### Konfiguracja (`.env`)

`BTC_WIF`, `SUI_PRIVATE_KEY`, `HTLC_PACKAGE_ID`, `RATE`, `SPREAD_BPS`, `QUOTE_TTL_S=60`, `MIN_CONF=0`, `BTC_LOCKTIME_BLOCKS=72`, `SUI_TIMEOUT_MS=3600000`, `SAFETY_BLOCKS=12`, `MIN_BTC_SATS=10000`, `MAX_BTC_SATS=1000000`, `GAS_RESERVE_MIST=200000000`, `ESPLORA_URL=https://mempool.space/signet/api`, `SUI_RPC_URL=https://fullnode.testnet.sui.io:443`, `PORT=8787`, `POLL_INTERVAL_MS=3000`, `DB_PATH=./hashbridge.db`.

Jeden `pub_bota` dla wszystkich swapów (prywatność nie ma znaczenia w demo).

## 5. Repo i stack

```
hashbridge/
├── contracts/sui/        Move.toml, sources/htlc.move, tests/
├── packages/core/        wspólny kod TS dla web i bota
│   ├── htlc-script.ts    witnessScript, adres P2WSH, parsowanie
│   ├── btc-tx.ts         budowanie i podpis tx claim oraz refund
│   ├── secret.ts         generowanie S, sha256
│   └── types.ts          Swap, SwapStatus, DTO API, stałe sieci
├── apps/bot/             Node ≥ 22.13 + Hono + node:sqlite
├── apps/web/             Vite + React + Tailwind
└── docs/specs/
```

Obecny kontrakt (`Move.toml`, `sources/`, `tests/` w katalogu głównym) zostaje przeniesiony do `contracts/sui/`.

**Biblioteki:**
- BTC: `bitcoinjs-lib` v6, `ecpair`, `@bitcoinerlab/secp256k1` (czysty JS), `@noble/hashes`.
- Sui: `@mysten/sui`, `@mysten/dapp-kit`.
- Esplora: `fetch`, bez SDK.
- UI: `qrcode.react`, Tailwind.
- Testy: `vitest`, `sui move test`.
- Monorepo: pnpm workspaces.

**Uruchomienie:** `pnpm dev` startuje bota i frontend lokalnie.

**Hosting (darmowy, z darmową domeną):** frontend na Vercel (`hashbridge.vercel.app`), bot na darmowym web service w Render (`hashbridge-bot.onrender.com`, blueprint `render.yaml`), darmowy monitor UptimeRobot co 5 min odpytuje `/health`, żeby Render nie usypiał bota. Na darmowym planie Render dysk jest ulotny: restart lub deploy kasuje SQLite, więc deploy bota jest ręczny i nie robi się go w trakcie swapu.

## 6. Obsługa błędów

| Sytuacja | Zachowanie |
|---|---|
| Wpłata za mała albo za późna | `REJECTED`, brak blokady SUI, UI pokazuje zwrot po locktime |
| Wpłata większa | SUI proporcjonalnie, do `MAX_BTC_SATS` |
| Kilka wpłat na ten sam adres | Bot obsługuje pierwszy UTXO, refund w UI wydaje wszystkie |
| Esplora albo RPC Sui nie odpowiada | Ponawianie w kolejnym cyklu pętli (co `POLL_INTERVAL_MS`), akcje idempotentne, stan bez zmian |
| Bot nie ma SUI | `POST /swaps` odmawia; spadek salda po wycenie → `REJECTED` |
| Użytkownik zamknął przeglądarkę | Wznowienie z localStorage albo pliku odzyskiwania. Bez ujawnienia S: refund SUI po terminie, refund BTC po locktime |
| Bot padł między claim na Sui a claim BTC | Po restarcie odczytuje S z eventu i odbiera BTC (czas do locktime) |
| RBF wpłaty przy 0-conf | Przyjęte w demo, poza sceną `MIN_CONF ≥ 1` |
| Opłaty BTC | `GET /fee-estimates` z Esplory, stała stawka jako fallback |

## 7. Testy

- **Move:** obecne testy + test `EBadPreimageLength`.
- **`packages/core`:** wektory testowe: hex skryptu, adres P2WSH (signet), struktura witness claim i refund, `nLockTime` w refund.
- **Bot:** maszyna stanów na atrapach interfejsów `BtcChain` i `SuiChain`, bez sieci.
- **E2E (ręcznie, signet):** pełny swap; zwrot BTC z `BTC_LOCKTIME_BLOCKS=2` (~20 min); lista kontrolna przed demo.

## 8. Kolejność prac

1. **Musi być (sobota):** poprawka kontraktu i deploy na Sui testnet; `core` (skrypt, adres, tx claim); bot w happy path z claim w imieniu użytkownika; web: formularz, wpłata, oś czasu.
2. **Powinno (niedziela rano):** plik odzyskiwania; ekran zwrotu BTC; refund SUI w bocie; wznawianie po odświeżeniu.
3. **Hosting:** Vercel + Render + UptimeRobot, przed E2E na wersji publicznej.
4. **Można:** „Connect wallet” i „Claim myself”; „Show HTLC script”; SSE zamiast odpytywania.
