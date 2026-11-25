# Vigora for citizens (phone app)

The citizen app for Android and iPhone, built with Expo. It runs in **Expo Go** and talks to the
same backend as the web apps: login and registration, reports with a map point and a photo,
the live status of your reports, and witness mode with confirmation questions.

## Run it on your phone

1. Install **Expo Go** from Google Play or the App Store.
2. Start the backend so the phone can reach it (listen on all addresses, port 8000):

   ```powershell
   cd backend
   python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```

   The first time, Windows asks whether Python may use the network: allow **private networks**.

3. In a second terminal start the app:

   ```powershell
   cd mobile
   npm install
   npx expo start
   ```

4. Scan the QR code: on Android with the Expo Go app, on iPhone with the Camera app.

The phone and the computer must be on the **same Wi‑Fi**. The app finds the backend by itself
(the computer's address with port 8000). If it cannot connect, tap **Сървър … · промени** under
the login card and type the address, for example `http://192.168.1.20:8000`. You can also set
`EXPO_PUBLIC_API_URL` before `npx expo start`.

## Demo accounts

`citizen1` … `citizen5`, password `citizen123`. Log in as different people on different phones
(or one on the phone and one in the web app) to see witness questions and live status changes.

`operator`, password `operator123`, opens the operator 112 panel: live stats, the map with the
teams and the incident queue, the same as the web panel at `/operator/`.

## Files

- `App.js`: fonts, saved login, login or home screen
- `src/api.js`: requests, login, the server address and the live WebSocket
- `src/LoginScreen.js`, `src/HomeScreen.js`, `src/OperatorScreen.js`: login, citizen home and operator panel
- `src/sheets.js`: report, location, witness question and "sent" sheets
- `src/ui.js`, `src/theme.js`: shared parts, colors and fonts
